import type { Mailbox } from './mailbox';

export interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_SENDERS: string;
}

/** Verified Access identity. */
export interface Identity {
  email: string;
  /** JWT `exp`, in milliseconds. */
  expMs: number;
}

/** Persisted under the `participants` key, one entry per email. */
export interface Participant {
  /** Queue order, ascending = earlier. Assigned once, never reused. */
  seq: number;
  /** Pressed "Request". */
  wants: boolean;
  /** When `wants` last went false -> true. */
  wantsSince: number;
  /** Set when this participant's socket count drops to zero. */
  lastSeenAt: number;
}

/**
 * Persisted under `lock`. A record of *when* the box changed hands, not of who
 * currently holds it — the holder is always derived in recompute(). This exists
 * solely so attribution can resolve a message that lands during a handoff.
 */
export interface LockLedger {
  holder: string | null;
  acquiredAt: number;
  prev: { email: string; releasedAt: number } | null;
}

export interface Deadline {
  email: string;
  expiresAt: number;
}

/** Stored on each WebSocket via serializeAttachment(). Must stay under 2 KB. */
export interface Attachment {
  email: string;
  expMs: number;
  connectedAt: number;
}

/** Parsed by the Worker's email() handler, handed to the DO over RPC. */
export interface IncomingMail {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  subjectMasked: string;
  text: string;
  html: string;
  authPass: boolean;
}

/** A row of the messages table, as SQLite returns it. */
export interface MessageRow {
  [column: string]: SqlStorageValue;
  id: number;
  received_at: number;
  from_addr: string;
  from_name: string;
  to_addr: string;
  subject: string;
  subject_masked: string;
  body_text: string;
  body_html: string;
  /** Immutable once written. NULL means nobody held the box when it arrived. */
  owner: string | null;
  auth_pass: number;
}

/** The columns a list row needs. Bodies are fetched separately, one at a time. */
export type MetaRow = Pick<
  MessageRow,
  | 'id'
  | 'received_at'
  | 'from_addr'
  | 'from_name'
  | 'to_addr'
  | 'subject'
  | 'subject_masked'
  | 'owner'
  | 'auth_pass'
>;

/** Message metadata as serialised for one specific recipient. Never carries a body. */
export interface Item {
  id: number;
  at: number;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  masked: boolean;
  owner: string | null;
  mine: boolean;
  /** Yours, or unowned. The single gate on subject and body. */
  readable: boolean;
  authPass: boolean;
}

export type Role = 'holder' | 'queued' | 'idle';

/**
 * One row of the presence list. Everyone with the page open appears, including
 * people who have not asked for the box.
 */
export interface Person {
  email: string;
  role: Role;
  /** 1-based place in the queue; null unless queued. */
  position: number | null;
  /** False while inside the reconnect grace with no live socket. */
  online: boolean;
  /** When they took the box, joined the queue, or first connected. */
  since: number;
}
