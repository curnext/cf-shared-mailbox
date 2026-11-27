/**
 * The one Access policy the admin page manages, and nothing else.
 *
 * The API token can edit every Access app and policy in the account, so this
 * module is deliberately narrow: the policy ID comes from config (never from a
 * request), and an edit touches only the plain `email` rules in `include`.
 * Every other field, and any other kind of rule, is sent back exactly as read.
 */

const API = 'https://api.cloudflare.com/client/v4';

/** Returned by GET but not accepted by PUT. */
const READ_ONLY = ['id', 'uid', 'created_at', 'updated_at', 'app_count', 'reusable'];

/** Generous for a shared mailbox, and a backstop against a runaway loop. */
export const MAX_USERS = 200;

export type Rule = Record<string, unknown>;

export interface Policy {
  include: Rule[];
  [field: string]: unknown;
}

export interface PolicyTarget {
  accountId: string;
  policyId: string;
  token: string;
}

export class AccessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Rejects the input with a reason a person can act on, or returns it normalised. */
export class InvalidEmail extends Error {}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function normaliseEmail(input: unknown): string {
  if (typeof input !== 'string') throw new InvalidEmail('email is required');
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new InvalidEmail('not a valid email address');
  return email;
}

function emailOf(rule: Rule): string | null {
  const inner = rule.email as { email?: unknown } | undefined;
  return inner && typeof inner.email === 'string' ? inner.email.toLowerCase() : null;
}

/** The plain email entries of `include`, lowercased, de-duplicated and sorted. */
export function emailsIn(policy: Policy): string[] {
  const out = new Set<string>();
  for (const rule of policy.include ?? []) {
    const email = emailOf(rule);
    if (email) out.add(email);
  }
  return [...out].sort();
}

function body(policy: Policy, include: Rule[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...policy, include };
  for (const field of READ_ONLY) delete out[field];
  return out;
}

/** The PUT body that adds `email`, or null when it is already present. */
export function withEmailAdded(policy: Policy, email: string): Record<string, unknown> | null {
  const current = emailsIn(policy);
  if (current.includes(email)) return null;
  if (current.length >= MAX_USERS) throw new InvalidEmail(`the list is full (${MAX_USERS} users)`);
  return body(policy, [...(policy.include ?? []), { email: { email } }]);
}

/** The PUT body that removes `email`, or null when it is not present. */
export function withEmailRemoved(policy: Policy, email: string): Record<string, unknown> | null {
  const include = policy.include ?? [];
  const kept = include.filter((rule) => emailOf(rule) !== email);
  if (kept.length === include.length) return null;
  // An allow policy with an empty include matches nobody, and the API may
  // reject it outright. Neither is something to do from a web page.
  if (kept.length === 0) throw new InvalidEmail('cannot remove the last user');
  return body(policy, kept);
}

async function call(
  target: PolicyTarget,
  method: 'GET' | 'PUT',
  payload?: Record<string, unknown>,
): Promise<Policy> {
  const res = await fetch(`${API}/accounts/${target.accountId}/access/policies/${target.policyId}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    errors?: { code?: number; message?: string }[];
    result?: Policy;
  } | null;

  if (!res.ok || !json?.success || !json.result) {
    const reason =
      json?.errors?.map((e) => `${e.message ?? 'error'}${e.code ? ` (${e.code})` : ''}`).join('; ') ||
      `HTTP ${res.status}`;
    throw new AccessApiError(reason, res.status);
  }
  return json.result;
}

export const readPolicy = (target: PolicyTarget) => call(target, 'GET');

export const writePolicy = (target: PolicyTarget, payload: Record<string, unknown>) =>
  call(target, 'PUT', payload);
