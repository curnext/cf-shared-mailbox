/**
 * Local preview entrypoint. NEVER DEPLOYED.
 *
 * `wrangler.toml` points at `src/index.ts` and has no idea this file exists;
 * only `wrangler.preview.toml` references it, and that config is only ever
 * passed to `wrangler dev`. So the Access bypass below cannot reach production
 * by any config mistake short of editing the deploy config by hand.
 *
 *   npm run preview        then open http://localhost:8787/_dev
 *
 * Identity comes from `?as=alice@example.com`, remembered in a cookie, so each
 * browser tab can be a different person and the roster, queue and locked-mail
 * states all become reachable without a second machine.
 */

import { htmlToText, mask, sanitiseHtml, truncate } from './mail';
import UI from './ui.html';
import type { Env, IncomingMail } from './types';

export { Mailbox } from './mailbox';

const DEFAULT_IDENTITY = 'you@example.com';
const PEOPLE = ['alice@example.com', 'bob@example.com', 'carol@example.com', DEFAULT_IDENTITY];

interface Sample {
  label: string;
  from: string;
  fromName: string;
  subject: string;
  html: string;
  text: string;
  authPass: boolean;
}

const SAMPLES: Record<string, Sample> = {
  code: {
    label: 'Verification code',
    from: 'no-reply@netflix.com',
    fromName: 'Netflix',
    subject: '123456 is your Netflix code',
    html:
      '<div style="font-family:sans-serif;max-width:480px">' +
      '<img src="https://track.example/logo.png" width="120" alt="Netflix">' +
      '<p>Hi,</p><p>Your verification code is:</p>' +
      '<p style="font-size:28px;letter-spacing:6px;font-weight:700">123456</p>' +
      '<p>It expires in 15 minutes. If you did not request it, ignore this email.</p>' +
      '<img src="https://track.example/pixel.gif" width="1" height="1">' +
      '</div>',
    text: 'Hi,\n\nYour verification code is:\n\n    123456\n\nIt expires in 15 minutes.\n\n\n\n\nIf you did not request it, ignore this email.\nhttps://netflix.com/account/security   ',
    authPass: true,
  },
  link: {
    label: 'Magic link',
    from: 'accounts@spotify.com',
    fromName: 'Spotify',
    subject: 'Sign in to Spotify',
    html:
      '<div style="font-family:sans-serif"><p>Tap below to finish signing in.</p>' +
      '<p><a href="https://accounts.spotify.com/verify?token=9f3a2b7c">Sign in to Spotify</a></p></div>',
    text: 'Tap the link below to finish signing in.\n\nhttps://accounts.spotify.com/verify?token=9f3a2b7c\n\nThe link is good for 10 minutes. Questions? See https://support.spotify.com.',
    authPass: true,
  },
  spoof: {
    label: 'Failing SPF/DKIM',
    from: 'security@netflix.com',
    fromName: 'Netflix Security',
    subject: 'Urgent: confirm your account 998877',
    html: '<p style="font-family:sans-serif">Confirm your account immediately.</p>',
    text: 'Confirm your account immediately.\n\nhttps://netflix-account-verify.example/confirm',
    authPass: false,
  },
  plain: {
    label: 'Plain text only',
    from: 'noreply@github.com',
    fromName: '',
    subject: '[GitHub] Please verify your device',
    html: '',
    text: 'Hey there,\n\nA sign in attempt requires further verification. Your device\nverification code is:\n\n    G-729481\n\nIf you did not attempt to sign in, please reset your password:\nhttps://github.com/settings/security\n\nThanks,\nThe GitHub Team',
    authPass: true,
  },
};

function identityOf(request: Request): string {
  const asParam = new URL(request.url).searchParams.get('as');
  if (asParam) return asParam.trim().toLowerCase();
  const match = /(?:^|;\s*)preview_as=([^;]+)/.exec(request.headers.get('Cookie') ?? '');
  return match ? decodeURIComponent(match[1]).toLowerCase() : DEFAULT_IDENTITY;
}

function stub(env: Env) {
  return env.MAILBOX.get(env.MAILBOX.idFromName('mailbox'));
}

function html(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function console_(current: string): string {
  const person = (email: string) =>
    `<a class="${email === current ? 'on' : ''}" href="/?as=${encodeURIComponent(email)}" target="_blank">${email}</a>`;
  const sample = (key: string) =>
    `<button onclick="fetch('/_dev/mail?kind=${key}').then(r=>r.text()).then(t=>{out.textContent=t})">${SAMPLES[key].label}</button>`;

  return `<!doctype html><meta charset="utf-8"><title>Preview console</title>
<style>
 body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#121C1A;background:#F5F7F6}
 @media(prefers-color-scheme:dark){body{background:#0B1211;color:#E6EDEB}a,button{color:#E6EDEB}}
 h1{font-size:1.2rem} h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:#8B9994;margin:2rem 0 .6rem}
 .row{display:flex;flex-wrap:wrap;gap:.5rem}
 a,button{font:inherit;font-size:.85rem;padding:.4rem .8rem;border-radius:8px;border:1px solid #D5DEDA;background:transparent;cursor:pointer;text-decoration:none;color:inherit}
 a.on{border-color:#0C6E66;color:#0C6E66;font-weight:600}
 p{color:#5A6B65;font-size:.88rem}
 @media(prefers-color-scheme:dark){p{color:#9FB0AB}a,button{border-color:#263734}}
 #out{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;color:#8B9994;min-height:1.4em;margin-top:.6rem}
</style>
<h1>CF Mailbox — preview console</h1>
<p>Access is not running locally, so identity comes from the link you use. Open two or three of these in separate tabs to see the roster, the queue and other people's locked mail.</p>

<h2>Open the app as</h2>
<div class="row">${PEOPLE.map(person).join('')}</div>

<h2>Deliver a test message</h2>
<p>Attributed exactly as production would attribute it — to whoever holds the mailbox at that moment, or to nobody.</p>
<div class="row">${Object.keys(SAMPLES).map(sample).join('')}</div>
<div id="out"></div>

<h2>Note</h2>
<p>Durable Object state is local and disposable. Restart <code>wrangler dev</code> to wipe the mailbox, the queue and the message table.</p>
<script>var out=document.getElementById('out')</script>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const identity = identityOf(request);

    if (url.pathname === '/_dev') return html(console_(identity));

    if (url.pathname === '/_dev/mail') {
      const sample = SAMPLES[url.searchParams.get('kind') ?? 'code'];
      if (!sample) return new Response('unknown kind', { status: 400 });

      const text = sample.text || htmlToText(sample.html);
      const mail: IncomingMail = {
        from: sample.from,
        fromName: sample.fromName,
        to: 'codes@example.com',
        subject: sample.subject,
        subjectMasked: mask(sample.subject),
        text: truncate(text),
        html: await sanitiseHtml(sample.html),
        authPass: sample.authPass,
      };
      await stub(env).deliver(mail);
      return new Response(`delivered: ${sample.subject}`, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const headers = new Headers(request.headers);
      headers.set('X-Identity-Email', identity);
      // Far enough out that the token-expiry path never fires while previewing.
      headers.set('X-Identity-Exp', String(Date.now() + 86_400_000));
      return stub(env).fetch(new Request(request, { headers }));
    }

    if (url.pathname === '/') {
      // Remember the chosen identity so the WebSocket upgrade can find it.
      return html(UI, {
        'Set-Cookie': `preview_as=${encodeURIComponent(identity)}; Path=/; SameSite=Lax`,
      });
    }

    return new Response('Not found — try /_dev', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
