# Deploying CF Mailbox

Written for someone who hasn't wired Cloudflare's pieces together before. Part 1
is the mental model — what each service actually *is* and how they connect. Part
2 is the steps. Part 3 is what to do when something doesn't work.

If you just want the commands, jump to [Part 2](#part-2--deployment). But the
ordering in Part 2 only makes sense if you've read Part 1, because several steps
exist purely to satisfy a dependency between services.

---

## Part 1 — the mental model

### Account, zone, DNS

Cloudflare has two levels of ownership, and almost every confusing error comes
from mixing them up.

- An **account** is you. Workers, Durable Objects and Zero Trust settings belong
  to the account.
- A **zone** is one domain (`example.com`). DNS records, Email Routing and
  Workers *routes* belong to a zone.

To put a domain in Cloudflare you change its nameservers at your registrar to
Cloudflare's. Cloudflare then answers all DNS for that domain — which is what
lets it sit in front of your traffic as a reverse proxy. This matters here
because **Email Routing only works when Cloudflare is your DNS provider for the
zone.** A partial/CNAME setup won't do.

In the DNS tab, records show an orange or grey cloud. Orange means proxied —
traffic goes through Cloudflare's edge, and only then to your origin. Workers
run at that edge. Grey means DNS-only, traffic goes straight to your server, and
Workers never see it.

### Worker

A **Worker** is your code, deployed to every Cloudflare edge location. There's no
server, no region, and nothing running when no request arrives. It wakes on an
event, runs, and stops.

A Worker exports handlers, one per kind of event. This project exports two:

```js
export default {
  async fetch(request, env)  { … }   // an HTTP request arrived
  async email(message, env)  { … }   // Email Routing delivered a message
}
```

That's the whole reason one deployment can serve the web page *and* receive mail:
they're two entrypoints into the same Worker, sharing the same bindings.

**Bindings** are how a Worker reaches anything outside itself. They arrive as
properties on `env`. `env.MAILBOX` is a binding to the Durable Object namespace;
`env.ACCESS_AUD` is a plain string binding. There are no connection strings and
no credentials in code — a binding is granted at deploy time from
`wrangler.toml`.

### Attaching a Worker to a hostname: routes vs custom domains

This is the step people get stuck on. There are two mechanisms and they are not
interchangeable.

| | **Custom Domain** | **Route** |
|---|---|---|
| Mental model | The Worker **is** the origin | The Worker sits **in front of** an existing origin |
| DNS record | Cloudflare creates it for you | Must already exist, and be proxied |
| Config | `custom_domain = true` | `pattern = "example.com/api/*"` |
| Use when | You have no server at all | You're intercepting traffic to a real server |

This project has no origin server — the Worker serves everything. So it wants a
**Custom Domain**, which is what the block at the bottom of `wrangler.toml`
sets up:

```toml
[[routes]]
pattern = "mailbox.example.com"
custom_domain = true
```

On deploy, Cloudflare creates the DNS record, provisions the TLS certificate, and
points the hostname at your Worker. You never create the DNS record by hand.

There's also `*.workers.dev` — a free hostname Cloudflare gives every Worker.
**We deliberately disable it** (`workers_dev = false`), because Access protects a
hostname, and a live `workers.dev` address is a second hostname that Access
doesn't cover. Leaving it on would publish the mailbox to the internet.

### Durable Object

The hardest one to place, because it has no equivalent in a normal stack. It is
not a database you connect to.

A **Durable Object** is a small, long-lived object — an instance of a class —
that lives at one place in the world and owns private storage. Two properties
make it useful here:

1. **Naming is global.** `idFromName("mailbox")` resolves to the same single
   instance from every edge location on earth. Two people in different countries
   hitting the mailbox reach the *same object*, not two copies.
2. **Execution is serialised.** One request at a time. There is no parallel
   access to its state.

Those two together are why this project needs almost no locking code. "Who holds
the mailbox" is answered by one object that can only think about one thing at a
time.

Two more things to know:

- **Storage backend.** Modern Durable Objects have a SQLite backend, which is
  what gives you `ctx.storage.sql`. You opt in at creation via
  `new_sqlite_classes`. This cannot be changed later for an existing class.
- **Migrations.** Cloudflare needs to be told when a DO class appears,
  is renamed, or is deleted. That's the `[[migrations]]` block:

  ```toml
  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["Mailbox"]
  ```

  `tag` is just a name; Cloudflare tracks which tags have been applied. You add a
  *new* block with a new tag for each future change — you don't edit the old one.
  Ordinary code changes need no migration at all.

### Cloudflare Access (Zero Trust)

**Access** is an authentication layer that runs at the edge, in front of your
Worker. It lives in a separate dashboard (`one.dash.cloudflare.com`) because it's
part of the Zero Trust product, but it applies to hostnames in your zones.

You create an **application**, which is really just "this hostname (and path) is
protected", and attach a **policy** — "allow these email addresses".

What happens on a request:

```
browser ──► Cloudflare edge
              │
              ├─ no valid session? ──► Access login page ──► email a one-time PIN
              │                                                     │
              │◄────────────────────── sets CF_Authorization cookie ┘
              │
              └─ valid session ──► injects Cf-Access-Jwt-Assertion header
                                   ──► your Worker finally runs
```

Your Worker code never sees an unauthenticated request. Three consequences worth
internalising:

- **Identity arrives as a signed JWT**, in the `Cf-Access-Jwt-Assertion` header.
  The `email` claim is who the person is. This project reads identity from there
  and nowhere else.
- **This Worker verifies that JWT itself** rather than trusting the header's
  presence. That's defence in depth: if a route ever escapes the Access
  application, the header simply won't be there and the Worker refuses.
- **The AUD tag matters.** Every Access application has an *Application Audience*
  tag, which lands in the JWT's `aud` claim. Checking it is what stops a token
  minted for some *other* Access app in your account from working here. That's
  why `ACCESS_AUD` is a required config value.

**Identity providers.** By default, Access offers **One-time PIN** — the person
types their email, Cloudflare mails them a code. For a friend group that is
exactly right: nobody needs a Google Workspace, and you never handle a password.

**Session duration** (default 24 hours) sets the JWT's `exp`. This app stores
`exp` on each WebSocket and closes the socket when it passes; the client
reconnects, passes through Access again, and keeps its queue position.

### Email Routing

**Email Routing** makes Cloudflare the mail server for your domain. Enabling it
adds MX records (and an SPF TXT record) to the zone, so the world delivers mail
for `@example.com` to Cloudflare instead of anywhere else.

You then write **routing rules**, each matching an address and choosing an
action. The action can be "forward to an external inbox" or — the one we want —
**"Send to a Worker"**.

Two things to know:

- A Worker only appears in that dropdown if it is **already deployed and exports
  an `email` handler**. This is why deployment has to happen before you configure
  routing.
- Email Routing is receive-only. Cloudflare will not send mail on your behalf,
  which is fine — this mailbox never replies.

### How it all fits together here

```
                    ┌──────────────────────────────────────────┐
   friend's         │            Cloudflare edge               │
   browser ────────►│  Access  ──►  Worker.fetch()  ──┐        │
                    │  (login)      serves UI, WS     │        │
                    │                                 ▼        │
                    │                        Durable Object    │
                    │                         "mailbox"        │
                    │                        lock · queue ·    │
                    │                        messages (SQL)    │
                    │                                 ▲        │
   netflix.com ────►│  Email Routing ──► Worker.email()┘        │
   sends a code     │  (MX records)      parse, allow-list     │
                    └──────────────────────────────────────────┘
```

Everything is one deployment. The only stateful thing is the Durable Object.

### What `wrangler.toml` is saying

| Line | Meaning |
|---|---|
| `name = "cf-mailbox"` | The Worker's name in your account. Also the deploy target. |
| `main = "src/index.ts"` | Entry file. Wrangler bundles from here. |
| `compatibility_date` | Pins runtime behaviour to a date, so a future runtime change can't break you. |
| `workers_dev = false` | Don't publish a `*.workers.dev` hostname. Load-bearing for security. |
| `rules = [{ type = "Text" … }]` | Lets `import UI from './ui.html'` work — bundles the file as a string. |
| `[[durable_objects.bindings]]` | Creates `env.MAILBOX`, pointing at the `Mailbox` class. |
| `[[migrations]]` | Tells Cloudflare the `Mailbox` class exists, with SQLite storage. |
| `[vars]` | Plain-text config, readable in the dashboard. Not for secrets. |
| `[[routes]] custom_domain` | The hostname people visit. |

**vars vs secrets.** `[vars]` values are visible in the dashboard and in your
repo — fine for a team domain, an AUD tag and a sender list, none of which are
credentials. If you ever need a real secret, use `npx wrangler secret put NAME`
instead; it's write-only and never appears in config.

---

## Part 2 — deployment

### Before you start

- A domain you control, and access to its registrar
- A Cloudflare account (free is fine)
- Node.js 18+
- `npm install` already run in this directory
- Your own `wrangler.toml`, which is gitignored:

  ```bash
  cp wrangler.toml.example wrangler.toml
  ```

  Steps 3, 5 and 6 below tell you what to put in it.

The order below is not arbitrary. Access needs a hostname to protect, so the
Worker deploys first. Email Routing needs a deployed Worker to route to, so it
comes last. In between, the app is deployed but rejects everyone — which is the
safe direction to be broken in.

### Step 1 — put the domain in Cloudflare

Cloudflare dashboard → **Add a site** → enter your domain → choose the Free plan.

Cloudflare scans your existing DNS and gives you two nameservers. Set those at
your registrar, replacing what's there. Then wait — this is the slow step, from
minutes to a few hours.

**Verify:** the domain shows **Active** in the Cloudflare dashboard. Don't
continue until it does; everything downstream depends on it.

### Step 2 — log in with Wrangler

```bash
npx wrangler login
```

Opens a browser, asks you to authorise, and stores a token locally.

**Verify:**

```bash
npx wrangler whoami
```

Should print your account name and ID. If you have more than one account, note
the ID — you may need `account_id = "…"` in `wrangler.toml`.

### Step 3 — choose your hostname

Decide what people will type. A subdomain is tidy: `mailbox.example.com`.

Edit `wrangler.toml` and put your hostname in the `[[routes]]` block:

```toml
[[routes]]
pattern = "mailbox.example.com"
custom_domain = true
```

Leave `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as placeholders for now — you can't
know them yet, and the Worker refusing everyone until they're right is correct
behaviour.

### Step 4 — first deploy

```bash
npm run preview   # optional: see it in a browser first, at localhost:8788/_dev
npm run check     # typecheck, tests, dry-run build — catches problems locally
npm run deploy
```

This creates the Worker, applies the `v1` migration (creating the `Mailbox`
Durable Object class with SQLite storage), and creates the DNS record and TLS
certificate for your hostname.

**Verify:** visit `https://mailbox.example.com`. You should get **401
Unauthorized** — no Access application exists yet, so no JWT is present and the
Worker correctly refuses. A 401 here means the Worker is running and its auth
check works. Certificate provisioning can take a minute or two on the first
request.

### Step 5 — create the Access application

Go to **`one.dash.cloudflare.com`** (Zero Trust, a different dashboard from the
main one). If it's your first visit you'll be asked to pick a **team name** —
this becomes `<team-name>.cloudflareaccess.com`, and it's your
`ACCESS_TEAM_DOMAIN`. You can find it later under **Settings → General → Team
domain**.

Then **Access → Applications → Add an application → Self-hosted**:

- **Application name:** anything, e.g. `Mailbox`
- **Session duration:** 24 hours is a reasonable default
- **Public hostname:** subdomain `mailbox`, domain `example.com`, **path empty**

  Leave the path blank. The application must cover the whole hostname —
  `/ws` has to be behind it too, or the WebSocket bypasses authentication.

Add a policy:

- **Policy name:** `Friends`
- **Action:** Allow
- **Include:** selector **Emails**, then add each person's address

Under login methods, make sure **One-time PIN** is enabled. It is by default, and
it means nobody needs any other account to sign in.

Save. Then open the application's **Overview** tab and copy the **Application
Audience (AUD) Tag** — a long hex string.

### Step 6 — configure and redeploy

Put both values into `wrangler.toml`:

```toml
[vars]
ACCESS_TEAM_DOMAIN = "your-team-name.cloudflareaccess.com"
ACCESS_AUD = "the-long-hex-string-you-just-copied"
ALLOWED_SENDERS = "netflix.com,spotify.com,no-reply@github.com"
```

`ACCESS_TEAM_DOMAIN` is the bare hostname — no `https://`, no trailing slash.

While you're here, set `ALLOWED_SENDERS` to the services you actually share.
Bare entries match the domain and its subdomains (`netflix.com` also matches
`mail.netflix.com`); entries containing `@` must match the full address exactly.
Mail from anywhere else is dropped without a bounce.

```bash
npm run deploy
```

**Verify:** open `https://mailbox.example.com` in a private window. You should be
redirected to a Cloudflare login page, receive a PIN by email, and then land on
the mailbox UI showing "Mailbox is free" and your own address in the corner.

Try **Request access** — the panel should switch to "You have the mailbox". Open
a second tab; it should also show you as holder, since tabs from one person count
as one participant.

### Step 7 — enable Email Routing

Main Cloudflare dashboard → your domain → **Email → Email Routing → Get started**.

Cloudflare will offer to add the required MX and TXT records. Accept. This is the
point at which your domain's mail starts arriving at Cloudflare, so if the domain
already receives mail somewhere, understand that this redirects it.

**Verify:** the Email Routing overview shows your records as configured. DNS
propagation for MX is usually quick but can take a while.

### Step 8 — route mail to the Worker

**Email → Email Routing → Routing rules → Create address**.

- **Custom address:** the mailbox address, e.g. `codes@example.com`
- **Action:** **Send to a Worker**
- **Destination:** `cf-mailbox`

If the Worker isn't in the dropdown, it hasn't been deployed with an `email`
handler — go back to step 4.

You can instead use **catch-all** (Email Routing → Routing rules → Catch-all
address) to send *every* address at the domain to the Worker. That's convenient
if you want per-service addresses like `netflix@example.com`, but it also means
spam to any address reaches your Worker. The allow-list drops it, so this is
mostly a noise question rather than a security one.

### Step 9 — test end to end

1. Open the mailbox, press **Request access**.
2. Trigger a real verification email from one of your allow-listed services.
3. It should appear within seconds. Open it — the message renders in a sandboxed
   frame with remote images stripped, and shows its exact arrival time.
4. Ask a friend to open the page. They should see "In use by …" and a
   **Request access** button, and your message with the subject masked.

Watch it live while testing:

```bash
npx wrangler tail
```

This streams logs from the deployed Worker. Dropped senders log a line, and so do
failed JWT verifications — both are the fastest way to see what's happening.

### Step 10 — add and remove people

Either use the admin page (Step 11), or edit the list by hand: Zero Trust →
Access → Applications → your app → **Policies** → edit the Emails list. A
hand-made removal takes effect on their next login; existing sessions last
until the session duration expires. A removal made on the admin page signs
them out immediately.

This list is the actual security boundary of the whole system. Nothing in the
app defends against someone who is on it.

### Step 11 — the admin page (optional)

A second Worker, `cf-mailbox-admin`, on its own hostname. Admins listed in its
config can see who has access, add people and remove them. It edits the plain
email rules of the mailbox's Access policy through the Cloudflare API, and
leaves every other rule and setting in that policy untouched.

It is a separate Worker so that the API token is never in the same place as the
code that parses mail from strangers. It bundles no npm packages.

1. **Make the mailbox's policy reusable.** Zero Trust → Access → Policies. If
   your app's policy is not listed there, create a reusable policy with the same
   emails and attach it to the app instead. Note its ID.
2. **Create the API token.** My Profile → API Tokens → Create Token → Custom.
   - Permissions: *Account* → **Access: Apps and Policies** → **Edit**.
   - Account Resources: *Include* → your account.
   - Set an expiry. Leave IP filtering empty: Workers do not send requests
     from fixed IP addresses.

   This token can edit every Access app and policy in the account. The Worker
   only ever touches the one policy ID in its config, but treat the token as
   being that powerful.
3. **Create an Access application for the admin hostname** (as in Step 5), with
   a policy that includes **only the admin emails**. Do not attach the mailbox's
   policy to it. Note its AUD tag.
4. **Configure and deploy:**

   ```bash
   cp wrangler.admin.toml.example wrangler.admin.toml   # fill in the values
   npx wrangler secret put CF_ACCESS_POLICY_KEY -c wrangler.admin.toml
   npm run deploy:admin
   ```

   Deploy the mailbox Worker first: the admin Worker binds to its Durable Object.

**What a removal does.** The email is taken out of the policy, so Access refuses
their next login. Then the mailbox records the time of removal and refuses any
Access token issued before it. Their open tabs show "access removed" and stop
reconnecting, and if they held the box it passes to the next person in the
queue. Someone added back later, on the page or by hand in the dashboard, gets
in again as soon as they log in again.

**Guard rails.** Admins cannot be removed from the page, and the last user
cannot be removed. Every add and remove is logged with the admin's email
(Workers → cf-mailbox-admin → Logs).

**Rotating the token.** Create the new token, run `wrangler secret put` again,
then delete the old token. No redeploy is needed.

---

## Part 3 — when it doesn't work

| Symptom | Cause | Fix |
|---|---|---|
| 401 on every page, even after logging in | `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` wrong | Re-copy the AUD tag from the app's Overview. Team domain is bare — no scheme, no slash. `wrangler tail` prints the exact verification failure. |
| No Access login page at all, straight to 401 | The Access app doesn't cover this hostname | Check the app's public hostname matches exactly, and that its path field is **empty**. |
| Page loads but the status dot stays red | WebSocket isn't connecting | Almost always the Access app has a path set, so `/ws` isn't covered. Also check `workers_dev = false` didn't leave a stale route. |
| Mail never arrives | Sender not allow-listed | `wrangler tail` will show `dropped disallowed sender …`. Add the domain to `ALLOWED_SENDERS` and redeploy. |
| Mail never arrives, nothing in the logs | Routing rule missing or MX not propagated | Check Email → Routing rules shows the address pointing at `cf-mailbox`. Check MX records exist and are proxy-grey (MX is never proxied). |
| Worker not in the Email Routing dropdown | Not deployed, or no `email` export | `npm run deploy`, then reload the dashboard page. |
| `Cannot apply new-sqlite-class migration to existing class` | The DO class already exists with the other storage backend | Only relevant if you deployed a variant earlier. Either pick a new `class_name`, or delete the Worker and redeploy. |
| Deploy says no routes configured | The `[[routes]]` block is still commented out | Step 3. |
| `wrangler dev` gives 401 for everything | Wrong config | Plain `wrangler dev` uses the production config, which requires an Access JWT that cannot exist locally. Use `npm run preview` instead. |
| Everyone shows as idle and nobody holds the box | Not a bug | Opening the page doesn't join the queue by design. Press **Request**. |

### Updating

Edit code, then:

```bash
npm run check && npm run deploy
```

Durable Object state survives deployments — the lock, the queue and the messages
table are all preserved. You only need a new `[[migrations]]` block if you add,
rename or delete a DO *class*.

To roll back, use the dashboard: **Workers & Pages → cf-mailbox → Deployments**,
find a previous version, and promote it.

### Changing the tunables

Everything in `src/constants.ts` — the three-minute clock, the 30-second
reconnect grace, the 90-second attribution window, the 100-message buffer. Edit,
redeploy. No migration, no state loss. The reasoning behind each value is in §05
and §06 of `spec.html`.

### What this costs

Metered on the Workers side: requests, CPU time, and Durable Object requests,
duration and stored data. Access is free for small teams (the free Zero Trust
plan covers up to 50 users). Email Routing is free.

For a handful of friends this sits comfortably in free-tier territory. Two design
choices help: the keepalive ping is answered at the edge by
`setWebSocketAutoResponse` and never wakes the Durable Object, and hibernation
means idle open tabs don't hold an object in memory. The one thing that would
change the picture is leaving many tabs open around the clock — check current
numbers on Cloudflare's Workers and Durable Objects pricing pages before assuming.

### Backups

There aren't any, deliberately. The ring buffer holds 100 messages and codes
expire in minutes — there is nothing here worth backing up, and less data at rest
is the safer posture. If you delete the Worker you delete the Durable Object and
its storage with it.
