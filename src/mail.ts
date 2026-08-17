/** §07 and §08 — sender allow-list, header checks, text extraction, masking. */

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

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Real OTP mail is routinely 100 KB+ of HTML. Keep only the readable part. */
export function truncate(text: string, limit = BODY_MAX_BYTES): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated]`;
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
