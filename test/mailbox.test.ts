/**
 * Drives the Durable Object directly, bypassing the Worker's Access check —
 * the DO is where the lock lives, so that is what these exercise.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IncomingMail } from '../src/types';

// Production addresses a single instance by name. Tests need a fresh one each
// time, or lock state and the ring buffer leak from one case into the next.
let instanceName = '';
let instanceCount = 0;

beforeEach(() => {
  instanceName = `mailbox-test-${++instanceCount}`;
});

function box() {
  return env.MAILBOX.get(env.MAILBOX.idFromName(instanceName));
}

// Env references DurableObjectNamespace<Mailbox> and Mailbox extends
// DurableObject<Env>, so inferring O here sends tsc round that cycle. The rest
// of the project is unaffected; only this call site needs inference switched off.
const runIn = runInDurableObject as unknown as (
  stub: unknown,
  callback: (instance: any, state: DurableObjectState) => unknown,
) => Promise<unknown>;

/** Reaches inside the object under test. Typed loosely on purpose. */
function inBox<R>(fn: (instance: any) => R | Promise<R>): Promise<R> {
  return runIn(box(), fn) as Promise<R>;
}

interface Client {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  latest(type: string): any;
  close(): void;
}

async function connect(email: string): Promise<Client> {
  const res = await box().fetch('https://do/ws', {
    headers: {
      Upgrade: 'websocket',
      'X-Identity-Email': email,
      'X-Identity-Exp': String(Date.now() + 3_600_000),
    },
  });
  expect(res.status).toBe(101);

  const ws = res.webSocket!;
  const frames: Record<string, unknown>[] = [];
  ws.accept();
  ws.addEventListener('message', (event: MessageEvent) => {
    frames.push(JSON.parse(event.data as string));
  });

  const client: Client = {
    ws,
    frames,
    latest(type) {
      for (let i = frames.length - 1; i >= 0; i--) if (frames[i].t === type) return frames[i];
      return undefined;
    },
    close() {
      ws.close(1000, 'test');
    },
  };

  await vi.waitFor(() => expect(client.latest('state')).toBeDefined());
  return client;
}

const send = (client: Client, payload: unknown) => client.ws.send(JSON.stringify(payload));

const role = (client: Client) => client.latest('state')?.you?.role;

const holderOf = (client: Client) =>
  client.latest('state')?.people?.find((p: any) => p.role === 'holder') ?? null;

const queueOf = (client: Client): any[] =>
  (client.latest('state')?.people ?? []).filter((p: any) => p.role === 'queued');

async function expectRole(client: Client, expected: string) {
  await vi.waitFor(() => expect(role(client)).toBe(expected));
}

function mail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    from: 'info@netflix.com',
    fromName: 'Netflix',
    to: 'box@example.com',
    subject: '123456 is your Netflix code',
    subjectMasked: '•••••• is your Netflix code',
    text: 'Your code is 123456. It expires in 15 minutes.',
    html: '<p>Your code is 123456.</p>',
    authPass: true,
    ...overrides,
  };
}

describe('the lock', () => {
  let alice: Client;
  let bob: Client;

  beforeEach(async () => {
    alice = await connect('alice@example.com');
    bob = await connect('bob@example.com');
  });

  it('starts everyone idle', () => {
    expect(role(alice)).toBe('idle');
    expect(holderOf(alice)).toBeNull();
  });

  it('gives the box to the first requester', async () => {
    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    await vi.waitFor(() =>
      expect(holderOf(bob)?.email).toBe('alice@example.com'),
    );
    expect(role(bob)).toBe('idle');
  });

  it('queues later requesters in arrival order', async () => {
    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    send(bob, { t: 'request' });
    await expectRole(bob, 'queued');

    expect(bob.latest('state').you.position).toBe(1);
    expect(queueOf(alice).map((p: any) => p.email)).toEqual(['bob@example.com']);
  });

  it('starts the eviction clock only once someone is waiting', async () => {
    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    expect(alice.latest('state').deadline).toBeNull();

    send(bob, { t: 'request' });
    await vi.waitFor(() => expect(alice.latest('state').deadline).toBeTypeOf('number'));
  });

  it('hands over on an explicit release', async () => {
    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    send(bob, { t: 'request' });
    await expectRole(bob, 'queued');

    send(alice, { t: 'release' });
    await expectRole(bob, 'holder');
    await expectRole(alice, 'idle');
  });

  it('treats a queued user leaving as clearing the clock', async () => {
    send(alice, { t: 'request' });
    send(bob, { t: 'request' });
    await expectRole(bob, 'queued');

    send(bob, { t: 'release' });
    await vi.waitFor(() => expect(alice.latest('state').deadline).toBeNull());
    expect(role(alice)).toBe('holder');
  });
});

describe('multiple tabs', () => {
  it('counts one participant per person, not per socket', async () => {
    const tab1 = await connect('alice@example.com');
    const tab2 = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    send(tab1, { t: 'request' });
    await expectRole(tab1, 'holder');
    await expectRole(tab2, 'holder');

    send(bob, { t: 'request' });
    await expectRole(bob, 'queued');
    expect(queueOf(bob)).toHaveLength(1);
  });

  it('keeps the box when one tab of several closes', async () => {
    const tab1 = await connect('alice@example.com');
    const tab2 = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    send(tab1, { t: 'request' });
    await expectRole(tab1, 'holder');
    send(bob, { t: 'request' });
    await expectRole(bob, 'queued');

    tab1.close();
    await vi.waitFor(() =>
      expect(holderOf(bob)?.email).toBe('alice@example.com'),
    );
    expect(role(tab2)).toBe('holder');
    expect(role(bob)).toBe('queued');
  });

  it('holds the position through a disconnect, inside the reconnect grace', async () => {
    const alice = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    send(bob, { t: 'request' });
    await expectRole(bob, 'queued');

    alice.close();
    // 30s of grace, so Bob must not be promoted just because a socket dropped.
    await vi.waitFor(() =>
      expect(holderOf(bob)?.online).toBe(false),
    );
    expect(role(bob)).toBe('queued');

    const aliceAgain = await connect('alice@example.com');
    await expectRole(aliceAgain, 'holder');
  });
});

describe('eviction', () => {
  it('drops the holder out rather than requeuing them', async () => {
    const alice = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    send(bob, { t: 'request' });
    await vi.waitFor(() => expect(alice.latest('state').deadline).toBeTypeOf('number'));

    // Pull the deadline into the past and run the real alarm handler.
    await inBox(async (instance) => {
      instance.deadline.expiresAt = Date.now() - 1;
      await instance.alarm();
    });

    await expectRole(bob, 'holder');
    await expectRole(alice, 'idle');
    await vi.waitFor(() => expect(alice.latest('evict')).toBeDefined());
    expect(alice.latest('evict').reason).toBe('timeout');
    expect(queueOf(bob)).toHaveLength(0);
  });
});

describe('ownership and masking', () => {
  it('attributes mail to a settled holder and hides it from everyone else', async () => {
    const alice = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');

    await inBox(async (instance) => {
      // Settle the handoff so this is unambiguously Alice's.
      // Settle the handover so this is unambiguously the holder's.
      instance.lock.prev = null;
      await instance.deliver(mail());
    });

    await vi.waitFor(() => expect(alice.latest('mail')).toBeDefined());
    const mine = alice.latest('mail').item;
    expect(mine.mine).toBe(true);
    expect(mine.subject).toBe('123456 is your Netflix code');

    const theirs = bob.latest('mail').item;
    expect(theirs.mine).toBe(false);
    expect(theirs.subject).toBe('•••••• is your Netflix code');
    expect(theirs.owner).toBe('alice@example.com');
    expect(theirs.readable).toBe(false);
  });

  it('serves a body to the owner and refuses everyone else', async () => {
    const alice = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    await inBox(async (instance) => {
      // Settle the handover so this is unambiguously the holder's.
      instance.lock.prev = null;
      await instance.deliver(mail());
    });
    await vi.waitFor(() => expect(alice.latest('mail')).toBeDefined());
    const id = alice.latest('mail').item.id;

    send(alice, { t: 'body', id });
    await vi.waitFor(() => expect(alice.latest('body')).toBeDefined());
    expect(alice.latest('body').text).toContain('123456');
    expect(alice.latest('body').html).toContain('Your code is');

    send(bob, { t: 'body', id });
    await vi.waitFor(() => expect(bob.latest('body')).toBeDefined());
    expect(bob.latest('body').denied).toBe(true);
    expect(bob.latest('body').text).toBeUndefined();
  });
});


describe('the ring buffer', () => {
  it('keeps the newest 100 messages', async () => {
    const alice = await connect('alice@example.com');

    await inBox(async (instance) => {
      for (let i = 0; i < 105; i++) {
        await instance.deliver(mail({ subject: `Message ${i}`, subjectMasked: `Message ${i}` }));
      }
    });

    send(alice, { t: 'archive' });
    await vi.waitFor(() => expect(alice.latest('archive')).toBeDefined());

    const items = alice.latest('archive').items;
    expect(items).toHaveLength(100);
    expect(items[0].subject).toBe('Message 104');
    expect(items.some((i: any) => i.subject === 'Message 4')).toBe(false);
  });
});

describe('the archive', () => {
  it('is readable by someone who never joined the queue', async () => {
    const alice = await connect('alice@example.com');
    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    await inBox(async (instance) => {
      // Settle the handover so this is unambiguously the holder's.
      instance.lock.prev = null;
      await instance.deliver(mail());
    });

    const carol = await connect('carol@example.com');
    expect(role(carol)).toBe('idle');

    send(carol, { t: 'archive' });
    await vi.waitFor(() => expect(carol.latest('archive')).toBeDefined());

    const items = carol.latest('archive').items;
    expect(items).toHaveLength(1);
    expect(items[0].subject).toBe('•••••• is your Netflix code');
    expect(items[0].owner).toBe('alice@example.com');
  });
});


describe('ownership is immutable (§07)', () => {
  it('credits the outgoing holder for mail that lands during a handover', async () => {
    const alice = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    send(bob, { t: 'request' });
    await expectRole(bob, 'queued');

    // The box changes hands, then Alice's code lands moments later.
    send(alice, { t: 'release' });
    await expectRole(bob, 'holder');
    await inBox((instance) => instance.deliver(mail()));
    await vi.waitFor(() => expect(bob.latest('mail')).toBeDefined());

    expect(bob.latest('mail').item.owner).toBe('alice@example.com');
    expect(bob.latest('mail').item.mine).toBe(false);
    expect(bob.latest('mail').item.readable).toBe(false);
    expect(alice.latest('mail').item.mine).toBe(true);

    // No way back: the new holder cannot take it, by any route.
    send(bob, { t: 'claim', id: bob.latest('mail').item.id });
    send(bob, { t: 'body', id: bob.latest('mail').item.id });
    await vi.waitFor(() => expect(bob.latest('body')).toBeDefined());
    expect(bob.latest('body').denied).toBe(true);
  });

  it('credits the settled holder once the handover window has passed', async () => {
    const alice = await connect('alice@example.com');

    send(alice, { t: 'request' });
    await expectRole(alice, 'holder');
    await inBox((instance: any) => {
      instance.lock.prev = { email: 'someone@example.com', releasedAt: Date.now() - 600_000 };
      return instance.deliver(mail());
    });

    await vi.waitFor(() => expect(alice.latest('mail')).toBeDefined());
    expect(alice.latest('mail').item.owner).toBe('alice@example.com');
    expect(alice.latest('mail').item.mine).toBe(true);
  });
});

describe('unowned mail is shared', () => {
  it('is readable in full by everyone, and never masked', async () => {
    const alice = await connect('alice@example.com');
    const bob = await connect('bob@example.com');

    // Nobody holds the box, and nobody released it recently.
    await inBox((instance: any) => {
      instance.lock.prev = null;
      return instance.deliver(mail());
    });
    await vi.waitFor(() => expect(bob.latest('mail')).toBeDefined());

    for (const client of [alice, bob]) {
      const item = client.latest('mail').item;
      expect(item.owner).toBeNull();
      expect(item.mine).toBe(false);
      expect(item.readable).toBe(true);
      expect(item.masked).toBe(false);
      expect(item.subject).toBe('123456 is your Netflix code');
    }

    send(bob, { t: 'body', id: bob.latest('mail').item.id });
    await vi.waitFor(() => expect(bob.latest('body')).toBeDefined());
    expect(bob.latest('body').denied).toBeUndefined();
    expect(bob.latest('body').text).toContain('123456');
  });
});
