/**
 * Worker entrypoint. Two paths reach the same Durable Object: browsers over an
 * authenticated WebSocket, and inbound mail through Email Routing.
 */

import PostalMime from 'postal-mime';

import { authenticate } from './access';
import { MAX_RAW_BYTES } from './constants';
import { authPassed, mask, sanitiseHtml, senderAllowed, textToHtml } from './mail';
import UI from './ui.html';
import type { Env, IncomingMail } from './types';

export { Mailbox } from './mailbox';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "connect-src 'self'",
    // Message bodies render in a sandboxed srcdoc iframe, which inherits this
    // policy. Remote images are stripped server-side and never load at all.
    "img-src 'self' data:",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function stub(env: Env) {
  return env.MAILBOX.get(env.MAILBOX.idFromName('mailbox'));
}

/** Pulls the address out of a raw `From:` header, without parsing the message. */
function addressInHeader(value: string | null): string {
  if (!value) return '';
  const angled = /<([^>]+)>/.exec(value);
  return (angled ? angled[1] : value).trim().toLowerCase();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const identity = await authenticate(request, env);
    if (!identity) {
      return new Response('Unauthorized', { status: 401, headers: SECURITY_HEADERS });
    }

    // An admin removal takes effect now, not when this session expires.
    if (!(await stub(env).admitted(identity.email, identity.iatMs))) {
      return new Response('Your access to this mailbox has been removed.', {
        status: 403,
        headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const headers = new Headers(request.headers);
      headers.set('X-Identity-Email', identity.email);
      headers.set('X-Identity-Exp', String(identity.expMs));
      return stub(env).fetch(new Request(request, { headers }));
    }

    if (url.pathname === '/') {
      return new Response(UI, {
        headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (message.rawSize > MAX_RAW_BYTES) {
      console.warn(`dropped oversized message from ${message.from} (${message.rawSize} bytes)`);
      return;
    }

    // The header From is what a person recognises, and it is the identity DMARC
    // aligns against. Fall back to the envelope sender for mail without one.
    //
    // Checked against pre-parsed headers, before the body is read: anyone can
    // send to this address, and rejecting a flood should not cost a MIME parse,
    // a Durable Object wake, or a storage write.
    const headerFrom = addressInHeader(message.headers.get('from'));
    const envelopeFrom = message.from.toLowerCase();

    if (
      !senderAllowed(headerFrom, env.ALLOWED_SENDERS) &&
      !senderAllowed(envelopeFrom, env.ALLOWED_SENDERS)
    ) {
      // Drop silently — bouncing would confirm the address exists.
      console.log(`dropped disallowed sender ${headerFrom || envelopeFrom}`);
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);

    const subject = parsed.subject ?? '(no subject)';
    const safeHtml = await sanitiseHtml(parsed.html?.trim() ? parsed.html : textToHtml(parsed.text ?? ''));

    const mail: IncomingMail = {
      from: parsed.from?.address?.toLowerCase() || headerFrom || envelopeFrom,
      fromName: parsed.from?.name ?? '',
      to: message.to,
      subject,
      subjectMasked: mask(subject),
      html: safeHtml,
      authPass: authPassed(message.headers),
    };

    await stub(env).deliver(mail);
  },
} satisfies ExportedHandler<Env>;
