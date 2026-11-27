# CF Mailbox

A shared inbox for one friend group's temporary login codes. One person holds it
at a time; the mail they receive belongs to them.

The full design is in [`spec.html`](./spec.html) — open it in a browser. Section
numbers referenced in code comments (§03, §06, §07…) point at it.

```
src/
  index.ts      Worker: serves the UI, authenticates, handles inbound mail
  preview.ts    Local-only entrypoint (never deployed) — see Previewing below
  mailbox.ts    Durable Object: the lock, the queue, the messages table
  access.ts     Cloudflare Access JWT verification (§03)
  mail.ts       Allow-list, header checks, HTML sanitising, subject masking (§07, §08)
  ui.html       The client, served as a text module
  constants.ts  Every tunable, in one place (§05)
  admin/        Optional admin Worker, on its own hostname (DEPLOY.md, Step 11)
    index.ts      Admin check, same-origin checks, add/remove endpoints
    policy.ts     Reads and edits the email rules of one Access policy
    admin.html    The admin page
test/
  mailbox.test.ts   Lock, queue, eviction, ownership, handover, sharing, ring buffer
  mail.test.ts      Masking, allow-list, HTML sanitising
  admin.test.ts     Admin auth, origin checks, policy edits, removal sign-out
```

## Setup

See **[DEPLOY.md](./DEPLOY.md)** — it explains what each Cloudflare service is
and does before walking through the steps, because the ordering only makes sense
once you know which service depends on which.

The short version:

```bash
npm install
cp wrangler.toml.example wrangler.toml   # then fill in the four marked values
npm run check                            # typecheck + tests + dry-run build
npm run deploy
```

`wrangler.toml` is gitignored — it carries your team domain, Access AUD tag,
hostname and sender list. `wrangler.toml.example` is the template, and every
value in it is explained in DEPLOY.md.

…with a domain in Cloudflare, an Access application on the hostname, its AUD tag
in `wrangler.toml`, and an Email Routing rule pointing at the Worker.

The admin page is a second Worker with its own config
(`wrangler.admin.toml`, also gitignored) and the Access API token as a secret:
`npm run deploy:admin`. See DEPLOY.md, Step 11.

## How it behaves

Opening the page puts you in the presence list as **idle**: one row per person,
showing who has the box (green), who is waiting (amber), who is just here (grey)
and who has dropped out momentarily (hollow). Only your own row has a button.
Press **Request** to join the queue.

The first requester holds the box. While nobody else is waiting they keep it
indefinitely. As soon as someone queues, a three-minute clock starts; when it
expires the holder drops out (they can request again, landing at the back) and
the box passes on.

Mail is attributed to whoever held the box when it arrived, **once and
permanently** — there is no claiming or transferring. Only the owner sees the body
and the unmasked subject; everyone else sees the sender, the recipient, the time,
and a masked subject. Mail that arrives while nobody holds the box belongs to
nobody, which means everyone can read it in full: there is no one to protect it
from. In one sentence — hold the box and you own what arrives; don't, and it
belongs to everyone.

The one wrinkle is delivery lag. A code triggered just before the box changes
hands routinely lands just after, so for 30 seconds after a handover the
*outgoing* holder keeps the credit.

Messages you cannot read still open — onto a watermarked note saying who received
it and how to get your own copy (request the mailbox, trigger the email again),
rather than silently refusing to respond.

Each message names all three addresses involved on their own lines: who sent it,
which of your addresses it landed on, and `received by` — you, another person, or
`no one · open to everyone` (for 10 minutes from arrival, after which it locks
for everyone).

Bodies render as HTML in a sandboxed iframe — scripts blocked, links opening in a
new tab, and remote images stripped server-side so nothing ever phones home.
The occasional text-only message is converted to HTML on arrival, monospace with
its URLs linkified.

Multiple tabs from the same person count as one participant. Closing a tab, or
losing your connection, keeps your place for 30 seconds.

## Previewing locally

```bash
npm run preview          # then open http://localhost:8788/_dev
```

Access cannot run locally, so `wrangler dev` against `wrangler.toml` would 401
everything. Instead there is a second entrypoint, `src/preview.ts`, referenced
only by `wrangler.preview.toml` — a separate file that is never passed to
`wrangler deploy`, so its Access bypass has no route into production.

The console at `/_dev` gives you:

- **Open the app as alice / bob / carol / you** — identity comes from `?as=` and
  is remembered in a cookie, so each tab is a different person. Two or three tabs
  is enough to see the roster, the queue, the countdown, and what someone else's
  locked mail looks like.
- **Four sample messages** — a verification code (with tracking pixels, to check
  they get stripped), a magic link, one failing SPF/DKIM, and a plain-text-only
  one. Each is attributed exactly as production would attribute it: to whoever
  holds the mailbox at that moment, or to nobody.

Everything except Access is the real thing — the real Durable Object, the real
lock, the real attribution and masking. Durable Object state is local and
disposable; restart to wipe it.

## Testing

```bash
npm test
```

Tests drive the Durable Object directly, bypassing the Worker's Access check —
the DO is where the lock lives. Each test gets its own DO instance, since
production addresses a single one by name.

Two cases are too slow to wait on, so they reach into the object: eviction pulls
`deadline.expiresAt` into the past and calls the real `alarm()`, and
settled-ownership clears `lock.prev`. Everything else runs through the real
WebSocket protocol.

## Things deliberately left out

- **No maximum session length.** An idle holder costs nothing while the queue is
  empty, and queue pressure covers every case where it does cost something.
- **No TTL sweep.** The 100-row ring buffer bounds storage, and codes expire on
  their own. Adding a 24-hour sweep means teaching the alarm to serve two
  purposes — see §13 of the spec.
- **No enforcement on SPF/DKIM/DMARC failure.** Results are surfaced in the UI as
  an `Unverified sender` chip rather than dropping the mail, so a misconfigured
  legitimate sender doesn't silently vanish. Tightening this to a hard drop is a
  two-line change in `src/index.ts`.
- **No code extraction.** Guessing which digits are the code is wrong often
  enough that a confidently displayed wrong code is worse than none. The message
  is rendered instead.
- **No frontend framework.** The UI is one file, served as a text module, with
  incremental DOM updates — needed regardless, since reparenting an iframe
  reloads it.

## Notes

- `workers_dev = false` is load-bearing. A live `*.workers.dev` route bypasses
  Access completely and hands the mailbox to the internet.
- The Worker verifies the Access JWT itself rather than trusting the proxy. This
  is defence in depth against a route that escapes the Access application.
- The UI's CSP allows `'unsafe-inline'` for its own inline script and styles.
  Tightening that means moving to a nonce, which the static text module can't
  carry — a small refactor in `src/index.ts` if you want it.
- Local `wrangler dev` will 401 everything, since there is no Access JWT outside
  the deployed hostname. The test suite is the way to exercise behaviour locally.
