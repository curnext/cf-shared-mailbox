/** §05 of the spec. All durations in milliseconds. */

/** Eviction clock, started when the queue becomes non-empty.
 *  Doubles as the liveness backstop for a zombie connection. */
export const QUEUE_PRESSURE_MS = 180_000;

/** Remaining time at which the holder's UI warns them. Client-side only. */
export const WARN_AT_MS = 30_000;

/** How long a participant with zero sockets keeps their queue position,
 *  so that a page refresh is free. */
export const RECONNECT_GRACE_MS = 30_000;

/**
 * After the box changes hands, arriving mail is credited to the *outgoing*
 * holder for this long. Delivery lag means a code triggered before a handover
 * routinely lands after it, and ownership is immutable — so this is the only
 * thing standing between the incoming holder and someone else's code.
 *
 * Short on purpose: it covers typical delivery lag without stealing mail the
 * new holder triggered themselves, which takes longer than this to arrange.
 */
export const HANDOFF_GRACE_MS = 30_000;

/** Messages retained. The archive is the ring buffer. */
export const RING_CAPACITY = 100;

/** Plaintext kept per message. */
export const BODY_MAX_BYTES = 8_192;

/** Sanitised HTML kept per message. 100 x 256 KB is ~25 MB worst case. */
export const HTML_MAX_BYTES = 262_144;

/** Largest raw message we will attempt to parse. */
export const MAX_RAW_BYTES = 2_000_000;

/**
 * Bumping this drops and recreates the messages table on next start. The
 * contents are 100 disposable verification codes, so a rebuild costs nothing
 * and is simpler than migrating columns.
 */
export const SCHEMA_VERSION = 4;

/** Edge-answered keepalive. Never reaches the Durable Object. */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';
