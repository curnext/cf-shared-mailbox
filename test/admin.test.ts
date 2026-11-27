/**
 * The admin Worker, end to end: a real signed Access JWT, a fake Cloudflare
 * API in place of `fetch`, and the real Mailbox Durable Object behind it.
 * Nothing here can reach the real Access policy.
 */

import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import admin, { type AdminEnv } from '../src/admin/index';
import {
  InvalidEmail,
  emailsIn,
  normaliseEmail,
  withEmailAdded,
  withEmailRemoved,
  type Policy,
} from '../src/admin/policy';

const TEAM = 'test.cloudflareaccess.com';
const AUD = 'admin-aud';
const ORIGIN = 'https://admin.example.com';
const TOKEN = 'secret-api-token';
const ADMIN = 'boss@example.com';

function adminEnv(): AdminEnv {
  return {
    MAILBOX: env.MAILBOX,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ADMIN_EMAILS: ` ${ADMIN.toUpperCase()} , other-admin@example.com`,
    CF_ACCOUNT_ID: 'acct',
    ACCESS_POLICY_ID: 'pol',
    CF_ACCESS_POLICY_KEY: TOKEN,
  };
}

// ------------------------------------------------------------- signed tokens

let signingKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  signingKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
});

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function jwt(email: string, aud = AUD): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'RS256', kid: 'k1' });
  const body = enc({ email, aud: [aud], iss: `https://${TEAM}`, iat: now, exp: now + 3600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

// --------------------------------------------------------- fake Cloudflare API

let policy: Policy;
let puts: Record<string, unknown>[];
let failNext: { status: number; message: string } | null;

beforeEach(() => {
  policy = {
    id: 'pol',
    uid: 'pol',
    name: 'MailboxPolicy',
    decision: 'allow',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    reusable: true,
    app_count: 1,
    session_duration: '24h',
    include: [
      { email: { email: 'Alice@Example.com' } },
      { email_domain: { domain: 'team.example.com' } },
      { email: { email: ADMIN } },
    ],
    exclude: [],
    require: [],
  };
  puts = [];
  failNext = null;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...publicJwk, kid: 'k1' }] });
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts/acct/access/policies/pol') {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
      if (failNext) {
        const { status, message } = failNext;
        failNext = null;
        return Response.json({ success: false, errors: [{ code: 10000, message }] }, { status });
      }
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        puts.push(body);
        policy = { ...policy, ...body, updated_at: new Date().toISOString() };
      }
      return Response.json({ success: true, errors: [], result: policy });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(
  method: string,
  path: string,
  options: { as?: string | null; body?: unknown; origin?: string | null; type?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  const who = options.as === undefined ? ADMIN : options.as;
  if (who) headers.set('Cf-Access-Jwt-Assertion', await jwt(who));
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.set('Origin', origin);
  if (options.body !== undefined) headers.set('Content-Type', options.type ?? 'application/json');
  return admin.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    adminEnv(),
  );
}

const mailbox = () => env.MAILBOX.get(env.MAILBOX.idFromName('mailbox'));

// --------------------------------------------------------------------- tests

describe('policy edits', () => {
  it('reads only plain email rules, normalised', () => {
    expect(emailsIn(policy)).toEqual(['alice@example.com', ADMIN]);
  });

  it('adds without touching other rules or fields, and drops read-only fields', () => {
    const body = withEmailAdded(policy, 'new@example.com')!;
    expect(body.include).toEqual([...policy.include, { email: { email: 'new@example.com' } }]);
    expect(body.session_duration).toBe('24h');
    for (const field of ['id', 'uid', 'created_at', 'updated_at', 'app_count', 'reusable']) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('treats an existing address, in any case, as a no-op', () => {
    expect(withEmailAdded(policy, 'alice@example.com')).toBeNull();
    expect(withEmailRemoved(policy, 'nobody@example.com')).toBeNull();
  });

  it('removes only the matching email rule', () => {
    const body = withEmailRemoved(policy, 'alice@example.com')!;
    expect(body.include).toEqual([
      { email_domain: { domain: 'team.example.com' } },
      { email: { email: ADMIN } },
    ]);
  });

  it('refuses to empty the policy', () => {
    const lonely: Policy = { include: [{ email: { email: 'a@example.com' } }] };
    expect(() => withEmailRemoved(lonely, 'a@example.com')).toThrow(InvalidEmail);
  });

  it('validates addresses', () => {
    expect(normaliseEmail('  Bob@Example.COM ')).toBe('bob@example.com');
    for (const bad of ['', 'bob', 'bob@', '@x.com', 'a b@x.com', 'a@x', 'a@x..com', '<a@x.com>', 42]) {
      expect(() => normaliseEmail(bad)).toThrow(InvalidEmail);
    }
  });
});

describe('admin worker', () => {
  it('rejects requests without a valid Access token', async () => {
    expect((await call('GET', '/', { as: null })).status).toBe(401);
  });

  it('rejects a token for a different Access app', async () => {
    const res = await admin.fetch(
      new Request(`${ORIGIN}/`, { headers: { 'Cf-Access-Jwt-Assertion': await jwt(ADMIN, 'mailbox-aud') } }),
      adminEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects signed-in non-admins', async () => {
    expect((await call('GET', '/', { as: 'alice@example.com' })).status).toBe(403);
    expect((await call('GET', '/api/users', { as: 'alice@example.com' })).status).toBe(403);
    expect(puts).toHaveLength(0);
  });

  it('serves the page to admins', async () => {
    const res = await call('GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain('Mailbox admin');
  });

  it('lists users and marks admins', async () => {
    const res = await call('GET', '/api/users');
    expect(await res.json()).toEqual({
      me: ADMIN,
      users: [
        { email: 'alice@example.com', admin: false },
        { email: ADMIN, admin: true },
      ],
    });
  });

  it('adds a user', async () => {
    const res = await call('POST', '/api/users', { body: { email: ' New@Example.com ' } });
    expect(res.status).toBe(200);
    expect(puts).toHaveLength(1);
    expect((await res.json() as any).users.map((u: any) => u.email)).toContain('new@example.com');
  });

  it('does not write when adding someone already present', async () => {
    const res = await call('POST', '/api/users', { body: { email: 'alice@example.com' } });
    expect(res.status).toBe(200);
    expect(puts).toHaveLength(0);
  });

  it('removes a user and ends their mailbox session', async () => {
    const issuedBefore = Date.now() - 1_000;
    const res = await call('DELETE', '/api/users', { body: { email: 'alice@example.com' } });
    expect(res.status).toBe(200);
    expect(puts).toHaveLength(1);
    expect(emailsIn(policy)).not.toContain('alice@example.com');
    expect(await mailbox().admitted('alice@example.com', issuedBefore)).toBe(false);
  });

  it('lets a re-added user back in', async () => {
    const issuedBefore = Date.now() - 1_000;
    await call('DELETE', '/api/users', { body: { email: 'alice@example.com' } });
    await call('POST', '/api/users', { body: { email: 'alice@example.com' } });
    expect(await mailbox().admitted('alice@example.com', issuedBefore)).toBe(true);
  });

  it('will not remove an admin', async () => {
    const res = await call('DELETE', '/api/users', { body: { email: ADMIN } });
    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it('rejects invalid addresses', async () => {
    const res = await call('POST', '/api/users', { body: { email: 'not-an-email' } });
    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it.each([
    ['another site', { origin: 'https://evil.example' }],
    ['no Origin header', { origin: null }],
    ['a form-encoded body', { type: 'application/x-www-form-urlencoded' }],
  ])('refuses changes from %s', async (_label, extra) => {
    const res = await call('POST', '/api/users', { body: { email: 'x@example.com' }, ...extra });
    expect(res.status).toBe(403);
    expect(puts).toHaveLength(0);
  });

  it('says so plainly when the API key secret is missing', async () => {
    const res = await admin.fetch(
      new Request(`${ORIGIN}/api/users`, { headers: { 'Cf-Access-Jwt-Assertion': await jwt(ADMIN) } }),
      { ...adminEnv(), CF_ACCESS_POLICY_KEY: '' },
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toContain('wrangler secret put');
  });

  it('reports Cloudflare API errors without leaking the token', async () => {
    failNext = { status: 403, message: 'Authentication error' };
    const res = await call('GET', '/api/users');
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('Authentication error');
    expect(text).not.toContain(TOKEN);
  });
});
