/**
 * The mailbox Durable Object. One global instance, addressed as
 * idFromName("mailbox"). DO execution is serialised, which is what makes the
 * lock correct without any locking code.
 *
 * The organising idea (§04): *presence* is derived from the live socket set and
 * never stored, so there is no code path that leaves the lock held by someone
 * who isn't connected. Only *ordering and timing* are persisted, because they
 * must outlast a hibernation cycle.
 */

import { DurableObject } from 'cloudflare:workers';

import {
  HANDOFF_GRACE_MS,
  PING,
  PONG,
  PUBLIC_WINDOW_MS,
  QUEUE_PRESSURE_MS,
  RECONNECT_GRACE_MS,
  REVOCATION_TTL_MS,
  RING_CAPACITY,
  SCHEMA_VERSION,
} from './constants';
import type {
  Attachment,
  Deadline,
  Env,
  IncomingMail,
  Item,
  LockLedger,
  MessageRow,
  MetaRow,
  Participant,
  Person,
  Role,
} from './types';

interface Member {
  email: string;
  participant: Participant;
  online: boolean;
}

const EMPTY_LOCK: LockLedger = { holder: null, acquiredAt: 0, prev: null };

/**
 * The single rule for who may see a message's subject and body. Yours always;
 * unowned only inside its public window; anyone else's never.
 */
function readableBy(
  row: Pick<MessageRow, 'owner' | 'received_at'>,
  email: string,
  now: number,
): boolean {
  if (row.owner === email) return true;
  return row.owner === null && now < row.received_at + PUBLIC_WINDOW_MS;
}

/**
 * Everything a list row needs, and nothing a list row doesn't. `SELECT *` here
 * would drag body_html — up to 256 KB a row — through memory on every archive
 * fetch, for columns the serialiser never touches.
 */
const META_COLUMNS =
  'id, received_at, from_addr, from_name, to_addr, subject, subject_masked, owner, auth_pass';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at    INTEGER NOT NULL,
    from_addr      TEXT    NOT NULL,
    from_name      TEXT    NOT NULL DEFAULT '',
    to_addr        TEXT    NOT NULL DEFAULT '',
    subject        TEXT    NOT NULL DEFAULT '',
    subject_masked TEXT    NOT NULL DEFAULT '',
    body_html      TEXT    NOT NULL DEFAULT '',
    owner          TEXT,
    auth_pass      INTEGER NOT NULL DEFAULT 0
  )`;

export class Mailbox extends DurableObject<Env> {
  private seq = 0;
  private participants: Record<string, Participant> = {};
  private lock: LockLedger = { ...EMPTY_LOCK };
  private deadline: Deadline | null = null;
  /** email -> when an admin removed them. See revoke(). */
  private revoked: Record<string, number> = {};
  /** Public mail whose window closed at or before this has been re-broadcast as locked. */
  private publicSwept = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Edge-answered keepalive: never wakes this object. Registered in the
    // constructor so it is reinstated after every hibernation wake.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));

    ctx.blockConcurrencyWhile(async () => {
      // The table holds 100 disposable codes, so a schema change rebuilds it
      // rather than migrating columns.
      const schema = await ctx.storage.get<number>('schemaVersion');
      if (schema !== SCHEMA_VERSION) {
        ctx.storage.sql.exec('DROP TABLE IF EXISTS messages');
        await ctx.storage.put('schemaVersion', SCHEMA_VERSION);
      }
      ctx.storage.sql.exec(CREATE_TABLE);
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS idx_messages_at ON messages(received_at DESC)',
      );

      this.seq = (await ctx.storage.get<number>('seq')) ?? 0;
      this.participants = (await ctx.storage.get<Record<string, Participant>>('participants')) ?? {};
      this.lock = (await ctx.storage.get<LockLedger>('lock')) ?? { ...EMPTY_LOCK };
      this.deadline = (await ctx.storage.get<Deadline | null>('deadline')) ?? null;
      this.revoked = (await ctx.storage.get<Record<string, number>>('revoked')) ?? {};
      this.publicSwept = (await ctx.storage.get<number>('publicSwept')) ?? 0;
    });
  }

  // ---------------------------------------------------------------- connection

  override async fetch(request: Request): Promise<Response> {
    const email = request.headers.get('X-Identity-Email');
    const expMs = Number(request.headers.get('X-Identity-Exp'));
    if (!email || !Number.isFinite(expMs)) return new Response('missing identity', { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [`u:${email}`]);
    const attachment: Attachment = { email, expMs, connectedAt: Date.now() };
    server.serializeAttachment(attachment);

    const now = Date.now();
    // Reusing an existing seq is what preserves queue position across a refresh.
    if (!this.participants[email]) {
      this.participants[email] = { seq: ++this.seq, wants: false, wantsSince: now, lastSeenAt: 0 };
    }

    await this.tick(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    const attachment = this.attachment(ws);
    if (!attachment) return;

    const now = Date.now();
    if (attachment.expMs && now > attachment.expMs) {
      this.send(ws, { t: 'bye', reason: 'token_expired' });
      ws.close(1000, 'token expired');
      await this.tick(now);
      return;
    }

    let frame: { t?: string; id?: number };
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    const { email } = attachment;

    // revoke() closes these sockets itself; this covers one that lingers.
    const revokedAt = this.revoked[email];
    if (revokedAt !== undefined && attachment.connectedAt <= revokedAt) {
      this.send(ws, { t: 'bye', reason: 'revoked' });
      ws.close(1008, 'access removed');
      return;
    }

    const participant = this.participants[email];

    switch (frame.t) {
      case 'request': {
        if (!participant || participant.wants) return;
        // A fresh seq puts them at the back. Keeping the one from when they
        // first connected would rank by who opened the page first, letting an
        // early arrival jump straight ahead of whoever holds the box.
        participant.seq = ++this.seq;
        participant.wants = true;
        participant.wantsSince = now;
        await this.tick(now);
        return;
      }
      case 'release': {
        if (!participant || !participant.wants) return;
        participant.wants = false;
        await this.tick(now);
        return;
      }
      case 'archive': {
        this.send(ws, { t: 'archive', items: this.archiveFor(email, now) });
        return;
      }
      case 'body': {
        if (typeof frame.id !== 'number') return;
        this.send(ws, this.bodyResponse(frame.id, email, now));
        return;
      }
      default:
        return;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  private async onGone(ws: WebSocket): Promise<void> {
    const attachment = this.attachment(ws);
    if (!attachment) return;

    const now = Date.now();
    const participant = this.participants[attachment.email];

    // The closing socket may still be listed, so compare by reference.
    const remaining = this.ctx
      .getWebSockets(`u:${attachment.email}`)
      .filter((other) => other !== ws);

    if (participant && remaining.length === 0) participant.lastSeenAt = now;
    await this.tick(now, ws);
  }

  // ------------------------------------------------------------------- the lock

  override async alarm(): Promise<void> {
    const now = Date.now();

    if (
      this.deadline &&
      now >= this.deadline.expiresAt &&
      this.lock.holder === this.deadline.email
    ) {
      const evicted = this.deadline.email;
      const participant = this.participants[evicted];
      // Drop out rather than requeue: with two active people, auto-requeue
      // rotates the box between them every three minutes forever.
      if (participant) participant.wants = false;
      this.deadline = null;
      this.sendToUser(evicted, { t: 'evict', reason: 'timeout' });
    }

    this.sweepPublic(now);
    await this.tick(now);
  }

  /**
   * §06. Recomputes the whole world from the live socket set, then persists and
   * broadcasts. Call at the end of every event. `excluding` is the socket
   * currently being closed, which may still appear in getWebSockets().
   */
  private async tick(now: number, excluding?: WebSocket): Promise<void> {
    const live = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excluding) continue;
      const attachment = this.attachment(ws);
      if (attachment) live.add(attachment.email);
    }

    // 1. purge participants who are gone and past their grace
    for (const [email, participant] of Object.entries(this.participants)) {
      if (!live.has(email) && now > participant.lastSeenAt + RECONNECT_GRACE_MS) {
        delete this.participants[email];
      }
    }

    // 2. the lock and the queue are just a sort
    const members: Member[] = Object.entries(this.participants)
      .map(([email, participant]) => ({ email, participant, online: live.has(email) }))
      .sort((a, b) => a.participant.seq - b.participant.seq);

    const wanters = members.filter((member) => member.participant.wants);
    const holder = wanters[0] ?? null;
    const queue = wanters.slice(1);

    // 3. record the transition, if any
    const holderEmail = holder?.email ?? null;
    if (holderEmail !== this.lock.holder) {
      if (this.lock.holder) this.lock.prev = { email: this.lock.holder, releasedAt: now };
      this.lock.holder = holderEmail;
      this.lock.acquiredAt = now;
    }

    // 4. queue pressure
    if (holder && queue.length > 0) {
      if (!this.deadline || this.deadline.email !== holder.email) {
        this.deadline = { email: holder.email, expiresAt: now + QUEUE_PRESSURE_MS };
      }
    } else {
      this.deadline = null;
    }

    // 5. wake for whichever comes first
    const wakes: number[] = [];
    if (this.deadline) wakes.push(this.deadline.expiresAt);
    if (holder && !holder.online) {
      wakes.push(holder.participant.lastSeenAt + RECONNECT_GRACE_MS);
    }
    const nextLock = this.nextPublicLock(now);
    if (nextLock !== null) wakes.push(nextLock);
    await this.scheduleAlarm(wakes.length > 0 ? Math.min(...wakes) : null);

    await this.ctx.storage.put({
      seq: this.seq,
      participants: this.participants,
      lock: this.lock,
      deadline: this.deadline,
      publicSwept: this.publicSwept,
    });

    this.broadcastState(now, members);
  }

  private async scheduleAlarm(at: number | null): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  // ------------------------------------------------------------ public window

  /** When the next still-open public message locks, if any. */
  private nextPublicLock(now: number): number | null {
    const row = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        'SELECT MIN(received_at) AS at FROM messages WHERE owner IS NULL AND received_at > ?',
        now - PUBLIC_WINDOW_MS,
      )
      .one();
    return row.at === null ? null : row.at + PUBLIC_WINDOW_MS;
  }

  /**
   * Readability is computed on every read, so the lock is already enforced the
   * moment the window closes. This only tells open tabs, so a message on
   * screen stops showing its subject and body without waiting for a refresh.
   */
  private sweepPublic(now: number): void {
    const ids = this.ctx.storage.sql
      .exec<{ id: number }>(
        `SELECT id FROM messages
          WHERE owner IS NULL AND received_at + ? > ? AND received_at + ? <= ?`,
        PUBLIC_WINDOW_MS,
        this.publicSwept,
        PUBLIC_WINDOW_MS,
        now,
      )
      .toArray();
    this.publicSwept = now;
    for (const { id } of ids) this.broadcastItem(id, now);
  }

  // ------------------------------------------------------------- admin hooks

  /**
   * Called by the Worker before serving anything. Access removes someone from
   * the policy for their *next* login only; their current session would carry
   * on until it expires. So a removal is recorded here by time, and any token
   * issued before it is refused.
   *
   * Keyed on time rather than on the email alone, so that someone re-added by
   * hand in the Cloudflare dashboard (which never calls unrevoke) gets back in
   * as soon as they log in again.
   */
  async admitted(email: string, iatMs: number): Promise<boolean> {
    const revokedAt = this.revoked[email];
    return revokedAt === undefined || iatMs > revokedAt;
  }

  /** Called by the admin Worker after removing `email` from the Access policy. */
  async revoke(email: string): Promise<void> {
    const now = Date.now();

    // Access sessions last at most a month, so older entries can never match.
    for (const [other, at] of Object.entries(this.revoked)) {
      if (now - at > REVOCATION_TTL_MS) delete this.revoked[other];
    }
    this.revoked[email] = now;
    await this.ctx.storage.put('revoked', this.revoked);

    for (const ws of this.ctx.getWebSockets(`u:${email}`)) {
      this.send(ws, { t: 'bye', reason: 'revoked' });
      try {
        ws.close(1008, 'access removed');
      } catch {
        // Already closing.
      }
    }

    // Drops them from the roster and, if they held the box, hands it on.
    delete this.participants[email];
    await this.tick(now);
  }

  /** Called by the admin Worker after adding `email` to the Access policy. */
  async unrevoke(email: string): Promise<void> {
    if (!(email in this.revoked)) return;
    delete this.revoked[email];
    await this.ctx.storage.put('revoked', this.revoked);
  }

  // -------------------------------------------------------------- mail intake

  /** Called over RPC by the Worker's email() handler. */
  async deliver(mail: IncomingMail): Promise<void> {
    const now = Date.now();
    const owner = this.attribute(now);

    this.ctx.storage.sql.exec(
      `INSERT INTO messages
         (received_at, from_addr, from_name, to_addr, subject, subject_masked,
          body_html, owner, auth_pass)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      now,
      mail.from,
      mail.fromName,
      mail.to,
      mail.subject,
      mail.subjectMasked,
      mail.html,
      owner,
      mail.authPass ? 1 : 0,
    );

    // Trim by rank, not by `id > max - N`: autoincrement leaves gaps and the
    // arithmetic form silently deletes the wrong rows. Finding the boundary id
    // walks the primary-key index instead of scanning every row, and the
    // subquery yields NULL — deleting nothing — until the buffer is full.
    this.ctx.storage.sql.exec(
      `DELETE FROM messages
        WHERE id <= (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      RING_CAPACITY,
    );

    const inserted = this.ctx.storage.sql
      .exec<{ id: number }>('SELECT MAX(id) AS id FROM messages')
      .one();
    this.broadcastItem(inserted.id, now);

    // Public mail needs a wake-up for when its window closes. Only ever pulls
    // the alarm earlier; the next tick recomputes every wake from scratch.
    if (owner === null) {
      const lockAt = now + PUBLIC_WINDOW_MS;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > lockAt) await this.ctx.storage.setAlarm(lockAt);
    }
  }

  /**
   * §07. Ownership is decided once, when the message arrives, and never
   * changes. The only subtlety is the handover: delivery lag means a code
   * triggered before the box changed hands routinely lands after it, so for a
   * short window the outgoing holder keeps the credit.
   *
   * Returns null when nobody was holding the box — which makes the message
   * readable by everyone for PUBLIC_WINDOW_MS, then by no one.
   */
  private attribute(now: number): string | null {
    if (this.lock.prev && now - this.lock.prev.releasedAt < HANDOFF_GRACE_MS) {
      return this.lock.prev.email;
    }
    return this.lock.holder;
  }

  // ------------------------------------------------------------ serialisation

  /**
   * Bodies never travel in a list. They cross the wire only in response to an
   * explicit request, checked against `owner` at that moment — so there is one
   * place to get right, and nothing for a later refactor to leak.
   */
  private bodyResponse(id: number, email: string, now: number): Record<string, unknown> {
    const row = this.ctx.storage.sql
      .exec<Pick<MessageRow, 'owner' | 'received_at' | 'body_html'>>(
        'SELECT owner, received_at, body_html FROM messages WHERE id = ?',
        id,
      )
      .toArray()[0];

    if (!row || !readableBy(row, email, now)) {
      return { t: 'body', id, denied: true };
    }
    return { t: 'body', id, html: row.body_html };
  }

  private itemFor(row: MetaRow, email: string, now: number): Item {
    const mine = row.owner === email;
    const readable = readableBy(row, email, now);
    return {
      id: row.id,
      at: row.received_at,
      from: row.from_addr,
      fromName: row.from_name,
      to: row.to_addr,
      subject: readable ? row.subject : row.subject_masked,
      masked: !readable,
      owner: row.owner,
      mine,
      readable,
      openUntil: row.owner === null ? row.received_at + PUBLIC_WINDOW_MS : null,
      authPass: row.auth_pass === 1,
    };
  }

  private archiveFor(email: string, now: number): Item[] {
    return this.ctx.storage.sql
      .exec<MetaRow>(
        `SELECT ${META_COLUMNS} FROM messages ORDER BY received_at DESC, id DESC`,
      )
      .toArray()
      .map((row) => this.itemFor(row, email, now));
  }

  /** Everyone with the page open, holder first, then the queue, then the idle. */
  private roster(members: Member[]): Person[] {
    const wanters = members.filter((member) => member.participant.wants);
    const idle = members.filter((member) => !member.participant.wants);

    const people: Person[] = wanters.map((member, index) => ({
      email: member.email,
      role: index === 0 ? ('holder' as Role) : ('queued' as Role),
      position: index === 0 ? null : index,
      online: member.online,
      since: index === 0 ? this.lock.acquiredAt : member.participant.wantsSince,
    }));

    for (const member of idle) {
      people.push({
        email: member.email,
        role: 'idle',
        position: null,
        online: member.online,
        since: member.participant.wantsSince,
      });
    }
    return people;
  }

  private broadcastState(now: number, members: Member[]): void {
    const people = this.roster(members);

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachment(ws);
      if (!attachment) continue;

      const you = people.find((person) => person.email === attachment.email);
      this.send(ws, {
        t: 'state',
        now,
        you: {
          email: attachment.email,
          role: you?.role ?? 'idle',
          position: you?.position ?? null,
        },
        people,
        deadline: this.deadline?.expiresAt ?? null,
      });
    }
  }

  /** Per-recipient because ownership differs. `mail` doubles as an upsert. */
  private broadcastItem(id: number, now: number): void {
    const row = this.ctx.storage.sql
      .exec<MetaRow>(`SELECT ${META_COLUMNS} FROM messages WHERE id = ?`, id)
      .toArray()[0];
    if (!row) return;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachment(ws);
      if (!attachment) continue;
      this.send(ws, { t: 'mail', item: this.itemFor(row, attachment.email, now) });
    }
  }

  // ------------------------------------------------------------------ plumbing

  private attachment(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null) ?? null;
    } catch {
      return null;
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Socket is closing; the resulting close event will reconcile state.
    }
  }

  private sendToUser(email: string, payload: unknown): void {
    for (const ws of this.ctx.getWebSockets(`u:${email}`)) this.send(ws, payload);
  }
}
