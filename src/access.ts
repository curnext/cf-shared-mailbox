/**
 * §03 — Cloudflare Access JWT verification.
 *
 * This is deliberately not redundant with putting the Access application in
 * front of the hostname: it is defence in depth against a route that escapes
 * the Access app. Identity comes from the verified `email` claim and nowhere
 * else — if the browser could assert who it is, anyone could steal the lock.
 */

import type { Env, Identity } from './types';

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

const JWKS_TTL_MS = 3_600_000;

let jwksCache: { fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(input: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input)));
}

async function loadKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  if (keys.size === 0) throw new Error('JWKS contained no usable RSA keys');

  jwksCache = { fetchedAt: Date.now(), keys };
  return keys;
}

async function keyFor(kid: string, teamDomain: string): Promise<CryptoKey> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  let keys = fresh ? jwksCache!.keys : await loadKeys(teamDomain);

  // Unknown kid on a cached set means rotation — refetch once before giving up.
  if (!keys.has(kid) && fresh) {
    jwksCache = null;
    keys = await loadKeys(teamDomain);
  }

  const key = keys.get(kid);
  if (!key) throw new Error(`no signing key for kid ${kid}`);
  return key;
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<Identity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  const header = b64urlToJson(rawHeader);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${String(header.alg)}`);
  if (typeof header.kid !== 'string') throw new Error('missing kid');

  const key = await keyFor(header.kid, teamDomain);
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSignature) as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  );
  if (!ok) throw new Error('bad signature');

  const claims = b64urlToJson(rawPayload);
  const nowSec = Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new Error('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > nowSec + 60) throw new Error('not yet valid');
  if (claims.iss !== `https://${teamDomain}`) throw new Error(`bad issuer ${String(claims.iss)}`);

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error('bad audience');

  if (typeof claims.email !== 'string' || !claims.email) throw new Error('no email claim');

  return { email: claims.email.toLowerCase(), expMs: claims.exp * 1000 };
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Returns null rather than throwing so callers answer 401 uniformly. The
 * cookie fallback matters for the WebSocket upgrade, where a browser cannot
 * set request headers itself.
 */
export async function authenticate(request: Request, env: Env): Promise<Identity | null> {
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(request, 'CF_Authorization');
  if (!token) return null;

  try {
    return await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  } catch (err) {
    console.warn('access verification failed:', (err as Error).message);
    return null;
  }
}
