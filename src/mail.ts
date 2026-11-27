/** §07 and §08 — sender allow-list, header checks, masking, HTML sanitising. */

import { BODY_MAX_BYTES, HTML_MAX_BYTES } from './constants';

/**
 * §08. Verification mail routinely puts the code in the subject line, so
 * "everyone sees titles" would leak the protected value outright. Mask any
 * short alphanumeric run that contains a digit; requiring the digit leaves
 * ordinary words alone. It over-masks occasionally, which is the right
 * direction to fail.
 *
 * Runs in the Durable Object, before the value goes on the wire.
 */
export function mask(subject: string): string {
  return subject.replace(/\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,16}\b/g, '••••••');
}

/**
 * Bare entries match the domain and its subdomains; entries containing `@`
 * must match the full address.
 */
export function senderAllowed(from: string, allowList: string): boolean {
  const addr = from.toLowerCase().trim();
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  if (!domain || !addr.includes('@')) return false;

  return allowList
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) =>
      entry.includes('@')
        ? entry === addr
        : domain === entry || domain.endsWith(`.${entry}`),
    );
}

/**
 * True only if SPF, DKIM and DMARC all pass. Surfaced in the UI because a
 * spoofed "here's your code" is otherwise indistinguishable from a real one,
 * and the whole point of this box is that people act on codes without thinking.
 */
export function authPassed(headers: Headers): boolean {
  const results = headers.get('authentication-results') ?? '';
  return (
    /\bspf=pass\b/i.test(results) &&
    /\bdkim=pass\b/i.test(results) &&
    /\bdmarc=pass\b/i.test(results)
  );
}

/** Real OTP mail is routinely 100 KB+ of HTML. Keep only the readable part. */
export function truncate(text: string, limit = BODY_MAX_BYTES): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated]`;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Matched against the raw text, and every piece is escaped on the way out.
// A URL can never contain a quote or angle bracket, and only http(s) matches,
// so javascript: and data: are never linked.
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

/**
 * For the occasional text-only message, so the client has a single way to
 * show a body. Escaped, with bare http(s) URLs made clickable; still passed
 * through sanitiseHtml afterwards like any other HTML.
 */
export function textToHtml(text: string): string {
  const tidy = truncate(
    text
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  if (!tidy) return '';

  let linked = '';
  let cursor = 0;
  for (const match of tidy.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCT, '');
    if (!url) continue;
    const at = match.index ?? 0;
    const safe = escapeHtml(url);
    linked += `${escapeHtml(tidy.slice(cursor, at))}<a href="${safe}">${safe}</a>`;
    cursor = at + url.length;
  }
  linked += escapeHtml(tidy.slice(cursor));

  return `<div style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.7">${linked}</div>`;
}

/** Elements removed outright, contents and all. */
const DROP = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'link',
  'meta',
  'title',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
].join(',');

/** Attributes that pull in a remote resource, beyond the img src we relocate. */
const REMOTE_ATTRS = ['srcset', 'background', 'poster', 'lowsrc', 'data-src'];

const UNSAFE_HREF = /^\s*(javascript|vbscript|data|file):/i;
/** `data:` stays allowed for images — inline logos are common and inert in <img>. */
const UNSAFE_SRC = /^\s*(javascript|vbscript|file):/i;

/**
 * The rendered body runs in a `sandbox` iframe with no scripts, so this is
 * defence in depth rather than the only line — but two jobs are genuinely its
 * own. It drops every remote resource, so no tracking pixel ever fires and the
 * URL never even reaches the browser, and it forces every link to open in a new
 * tab with the opener detached.
 *
 * HTMLRewriter is part of the Workers runtime, so this needs no dependency.
 */
export async function sanitiseHtml(raw: string): Promise<string> {
  if (!raw.trim()) return '';

  const stripEventHandlers = {
    element(element: Element) {
      const doomed: string[] = [];
      for (const [name] of element.attributes) {
        if (name.toLowerCase().startsWith('on')) doomed.push(name);
      }
      for (const name of doomed) element.removeAttribute(name);
    },
  };

  const rewritten = new HTMLRewriter()
    .on(DROP, {
      element(element) {
        element.remove();
      },
    })
    .on('*', stripEventHandlers)
    .on('a', {
      element(element) {
        const href = element.getAttribute('href');
        if (href && UNSAFE_HREF.test(href)) element.removeAttribute('href');
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      },
    })
    .on('img', {
      element(element) {
        for (const attr of REMOTE_ATTRS) element.removeAttribute(attr);

        const src = element.getAttribute('src');
        element.removeAttribute('src');
        // Inline images fetch nothing, so they are the one kind that may stay.
        if (src && src.startsWith('data:') && !UNSAFE_SRC.test(src)) {
          element.setAttribute('src', src);
        }
      },
    })
    .on('source, video, audio, track', {
      element(element) {
        element.removeAttribute('src');
        for (const attr of REMOTE_ATTRS) element.removeAttribute(attr);
      },
    })
    .transform(new Response(truncate(raw, HTML_MAX_BYTES)));

  return rewritten.text();
}
