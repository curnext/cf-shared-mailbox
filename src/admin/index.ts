/**
 * Admin Worker. A separate Worker on its own hostname, so the Access API token
 * lives somewhere that never parses inbound mail and bundles no npm packages.
 *
 * Three layers stand in front of every change:
 *   1. Cloudflare Access, with an admins-only policy on this hostname;
 *   2. the verified Access JWT, checked against ADMIN_EMAILS here;
 *   3. same-origin JSON requests only, so another site cannot drive a
 *      logged-in admin's browser into making changes.
 */

import { authenticate } from '../access';
import type { Mailbox } from '../mailbox';
import PAGE from './admin.html';
import {
  AccessApiError,
  InvalidEmail,
  emailsIn,
  normaliseEmail,
  readPolicy,
  withEmailAdded,
  withEmailRemoved,
  writePolicy,
  type PolicyTarget,
} from './policy';

export interface AdminEnv {
  /** The mailbox Worker's Durable Object, bound across scripts. */
  MAILBOX: DurableObjectNamespace<Mailbox>;
  ACCESS_TEAM_DOMAIN: string;
  /** AUD tag of the *admin* Access application, not the mailbox one. */
  ACCESS_AUD: string;
  ADMIN_EMAILS: string;
  CF_ACCOUNT_ID: string;
  ACCESS_POLICY_ID: string;
  /** Secret. Set with `wrangler secret put`, never in a config file. */
  CF_ACCESS_POLICY_KEY: string;
}

const HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function admins(env: AdminEnv): string[] {
  return env.ADMIN_EMAILS.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function target(env: AdminEnv): PolicyTarget {
  return { accountId: env.CF_ACCOUNT_ID, policyId: env.ACCESS_POLICY_ID, token: env.CF_ACCESS_POLICY_KEY };
}

function mailbox(env: AdminEnv) {
  return env.MAILBOX.get(env.MAILBOX.idFromName('mailbox'));
}

function listing(emails: string[], adminList: string[], me: string) {
  return {
    me,
    users: emails.map((email) => ({ email, admin: adminList.includes(email) })),
  };
}

/**
 * Browsers always send Origin on a cross-site POST/DELETE, and a JSON body
 * forces a CORS preflight that this Worker never answers.
 */
function sameOrigin(request: Request, url: URL): boolean {
  if (request.headers.get('Origin') !== url.origin) return false;
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return false;
  return (request.headers.get('Content-Type') ?? '').startsWith('application/json');
}

async function emailFrom(request: Request): Promise<string> {
  const payload = (await request.json().catch(() => null)) as { email?: unknown } | null;
  return normaliseEmail(payload?.email);
}

async function handleApi(request: Request, env: AdminEnv, url: URL, me: string): Promise<Response> {
  const adminList = admins(env);

  if (request.method === 'GET') {
    const policy = await readPolicy(target(env));
    return json(200, listing(emailsIn(policy), adminList, me));
  }

  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return json(405, { error: 'method not allowed' });
  }
  if (!sameOrigin(request, url)) return json(403, { error: 'cross-origin request refused' });

  const email = await emailFrom(request);

  if (request.method === 'POST') {
    const policy = await readPolicy(target(env));
    const next = withEmailAdded(policy, email);
    const result = next ? await writePolicy(target(env), next) : policy;
    // Also clears an earlier removal, so a returning user is not still blocked.
    await mailbox(env).unrevoke(email);
    if (next) console.log(JSON.stringify({ audit: 'user_added', by: me, email }));
    return json(200, listing(emailsIn(result), adminList, me));
  }

  // DELETE
  if (adminList.includes(email)) throw new InvalidEmail('admins cannot be removed here');

  const policy = await readPolicy(target(env));
  const next = withEmailRemoved(policy, email);
  const result = next ? await writePolicy(target(env), next) : policy;
  // Unconditional, so retrying a removal whose first attempt failed half way
  // still ends the user's session.
  await mailbox(env).revoke(email);
  if (next) console.log(JSON.stringify({ audit: 'user_removed', by: me, email }));
  return json(200, listing(emailsIn(result), adminList, me));
}

export default {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    const url = new URL(request.url);

    const identity = await authenticate(request, env);
    if (!identity) return new Response('Unauthorized', { status: 401, headers: HEADERS });

    if (!admins(env).includes(identity.email)) {
      console.warn(JSON.stringify({ audit: 'admin_denied', email: identity.email }));
      return new Response('Forbidden', { status: 403, headers: HEADERS });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(PAGE, {
        headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/users') {
      if (!env.CF_ACCESS_POLICY_KEY) {
        // Otherwise Cloudflare answers "Bearer undefined" with an opaque 9106.
        return json(500, {
          error: 'CF_ACCESS_POLICY_KEY is not set. Run: wrangler secret put CF_ACCESS_POLICY_KEY -c wrangler.admin.toml',
        });
      }
      try {
        return await handleApi(request, env, url, identity.email);
      } catch (err) {
        if (err instanceof InvalidEmail) return json(400, { error: err.message });
        if (err instanceof AccessApiError) {
          // The message comes from Cloudflare's API and carries no credentials.
          console.error(`access api ${err.status}: ${err.message}`);
          return json(502, { error: `Cloudflare API: ${err.message}` });
        }
        console.error('admin request failed:', (err as Error).message);
        return json(500, { error: 'internal error' });
      }
    }

    return new Response('Not found', { status: 404, headers: HEADERS });
  },
} satisfies ExportedHandler<AdminEnv>;
