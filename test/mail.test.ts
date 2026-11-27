import { describe, expect, it } from 'vitest';

import { authPassed, mask, sanitiseHtml, senderAllowed, textToHtml } from '../src/mail';

describe('mask (§08)', () => {
  it('masks codes that appear in real subject lines', () => {
    expect(mask('123456 is your Netflix code')).toBe('•••••• is your Netflix code');
    expect(mask('G-729481 is your Google verification code')).toBe(
      '•••••• is your Google verification code',
    );
    expect(mask('Your Discord code: 483920')).toBe('Your Discord code: ••••••');
    expect(mask('[Steam] 5XK2M is your login code')).toBe('[Steam] •••••• is your login code');
  });

  it('leaves ordinary words alone', () => {
    expect(mask('Your Netflix account')).toBe('Your Netflix account');
    expect(mask('Reset your password')).toBe('Reset your password');
    expect(mask('Sign-in attempt blocked')).toBe('Sign-in attempt blocked');
  });

  it('never leaves a digit run of code length unmasked', () => {
    for (const subject of [
      '999999 is your code',
      'Code 4821',
      'use 12345678 to sign in',
      'ABC123 confirms your login',
    ]) {
      expect(mask(subject)).not.toMatch(/\d{4}/);
    }
  });
});

describe('senderAllowed', () => {
  const list = 'netflix.com,spotify.com,no-reply@github.com';

  it('matches a bare domain and its subdomains', () => {
    expect(senderAllowed('info@netflix.com', list)).toBe(true);
    expect(senderAllowed('info@mail.netflix.com', list)).toBe(true);
  });

  it('requires a full match for entries containing @', () => {
    expect(senderAllowed('no-reply@github.com', list)).toBe(true);
    expect(senderAllowed('security@github.com', list)).toBe(false);
  });

  it('rejects lookalike domains', () => {
    expect(senderAllowed('info@notnetflix.com', list)).toBe(false);
    expect(senderAllowed('info@netflix.com.evil.net', list)).toBe(false);
    expect(senderAllowed('', list)).toBe(false);
  });
});

describe('authPassed', () => {
  const withResults = (value: string) => new Headers({ 'Authentication-Results': value });

  it('requires all three to pass', () => {
    expect(authPassed(withResults('spf=pass; dkim=pass; dmarc=pass'))).toBe(true);
    expect(authPassed(withResults('spf=pass; dkim=fail; dmarc=pass'))).toBe(false);
    expect(authPassed(withResults('spf=pass; dkim=pass'))).toBe(false);
    expect(authPassed(new Headers())).toBe(false);
  });
});

describe('textToHtml', () => {
  it('escapes markup in the text', () => {
    const html = textToHtml('Code <b>123456</b> & "more"');
    expect(html).toContain('Code &lt;b&gt;123456&lt;/b&gt; &amp; &quot;more&quot;');
    expect(html).not.toContain('<b>');
  });

  it('links bare http(s) URLs, leaving trailing punctuation outside', () => {
    const html = textToHtml('Visit https://x.com/verify?a=1&b=2. Or javascript:alert(1)');
    expect(html).toContain('<a href="https://x.com/verify?a=1&amp;b=2">https://x.com/verify?a=1&amp;b=2</a>.');
    expect(html).not.toContain('href="javascript');
  });

  it('cannot break out of an attribute', () => {
    const html = textToHtml('https://x.com/"onmouseover="alert(1)');
    expect(html).toContain('<a href="https://x.com/">https://x.com/</a>&quot;onmouseover');
  });

  it('returns nothing for empty text', () => {
    expect(textToHtml('  \n ')).toBe('');
  });
});

describe('sanitiseHtml', () => {
  it('removes scripts and event handlers', async () => {
    const html = await sanitiseHtml(
      '<p onclick="steal()">hi</p><script>steal()</script><iframe src="x"></iframe>',
    );
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('iframe');
    expect(html).toContain('hi');
  });

  it('drops remote image sources entirely, URL included', async () => {
    const html = await sanitiseHtml(
      '<img src="https://track.example/pixel.gif"><img srcset="https://cdn.example/l.png 2x">',
    );
    expect(html).not.toContain('track.example');
    expect(html).not.toContain('cdn.example');
    expect(html).not.toMatch(/\ssrc(set)?=/);
  });

  it('leaves inline data images alone', async () => {
    const html = await sanitiseHtml('<img src="data:image/png;base64,AAAA">');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('detaches links and strips javascript hrefs', async () => {
    const html = await sanitiseHtml(
      '<a href="https://verify.example/abc">Verify</a><a href="javascript:evil()">x</a>',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://verify.example/abc"');
    expect(html).not.toContain('javascript:');
  });
});
