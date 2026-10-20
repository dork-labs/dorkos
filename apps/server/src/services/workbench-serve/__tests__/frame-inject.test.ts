import { describe, expect, it } from 'vitest';
import { WORKBENCH } from '../../../config/constants.js';
import { injectFrameScripts } from '../frame-inject.js';
import { DOC_FRAME_SHIM_SCRIPT } from '../../canvas/doc-frame-shim.js';
import { DEVTOOLS_AGENT_SCRIPT } from '../devtools-shim.js';

const html =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Page</title><script>window.user = true;</script></head><body>Hi</body></html>';
const inject = (
  value: string | Buffer,
  policies: readonly string[] = [],
  contentType = 'text/html; charset=utf-8'
) =>
  injectFrameScripts(typeof value === 'string' ? Buffer.from(value) : value, {
    contentType,
    enforcingPolicies: policies,
  });

describe('one fixed frame SDK insertion decision', () => {
  it('inserts both exact fixed scripts before user code without moving charset/viewport or changing other bytes', () => {
    const result = inject(html);
    expect(result.instrumented).toBe(true);
    expect(result.reason).toBeNull();
    const addition = `<script>${DOC_FRAME_SHIM_SCRIPT}</script><script>${DEVTOOLS_AGENT_SCRIPT}</script>`;
    expect(result.bytes.toString()).toBe(html.replace('<head>', `<head>${addition}`));
    expect(result.bytes.toString().indexOf('dorkos-doc')).toBeLessThan(
      result.bytes.toString().indexOf('window.user')
    );
    expect(result.bytes.toString().indexOf('__dorkosDevtools')).toBeLessThan(
      result.bytes.toString().indexOf('window.user')
    );
  });

  it.each([
    '<HTML><HEAD data-name="ordinary > name"><title>Page</title></HEAD><BODY>Hi</BODY></HTML>',
    '\ufeff \n<!DOCTYPE HTML><html><head><meta charset="UTF8"></head><body>é</body></html>',
    '<!-- an inert <head> and <script> --><html><head></head><body></body></html>',
    '<html><head><title>a &lt;head&gt;</title><style>/* <head> */</style></head><body><textarea><head>text</textarea><script>const text = "<head>";</script></body></html>',
    '<head><meta http-equiv="content-type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width"></head>',
  ])('recognizes supported explicit head and inert raw text: %s', (value) => {
    expect(inject(value).instrumented).toBe(true);
  });

  it.each([
    '<html><body>headless</body></html>',
    '<div>fragment</div>',
    '<!doctype html><body>headless</body>',
    '<script>early()</script><html><head></head></html>',
    '<html><head><meta http-equiv="Content-Security-Policy" content="script-src *"></head></html>',
    '<html><head><script>first()</script><meta http-equiv="content-security-policy" content="script-src none"></head></html>',
    '<html><head><meta http-equiv="content&#45;security-policy" content="script-src none"></head></html>',
    '<html><head><meta charset="iso-8859-1"></head></html>',
    '<html><head><meta charset="utf-8"><meta charset="utf8"></head></html>',
    '<html><head><meta charset="utf-8" CHARSET="utf8"></head></html>',
    '<html><head><meta http-equiv="refresh" content="0;url=/other"></head></html>',
    '<!-- <head> --!><html><head></head></html>',
    '<html><head></head><head></head></html>',
    '<html><head><title>never closed</head></html>',
    '<!DOCTYPE html PUBLIC "unknown"><html><head></head></html>',
    '<html><head><noscript><meta charset="utf8"></noscript></head></html>',
    '<html><head><script><!-- <script>double escaped</script></script></head></html>',
    '<html><head>implicit head closing<script>page()</script></head></html>',
    '<html><head data-x="never closed></head></html>',
    '<html><head/></html>',
    '<svg><path d="M0 0"/></svg><html><head></head><body></body></html>',
    '<html><svg></svg><head></head><body></body></html>',
    '<html><head><svg><path/></svg></head><body></body></html>',
    '<html><head><template><script>early()</script></template></head><body></body></html>',
    '<html><head><script>const s = "</head><body>";</script><noscript></noscript></head><body></body></html>',
    '<html><head></head><meta http-equiv="content-security-policy" content="script-src \'none\'"><body></body></html>',
    '<html><head></head><template><p>x</p></template><body></body></html>',
    '<html><head></head><script/><body></body></html>',
  ])('refuses uncertain markup/metadata and keeps the original Buffer: %s', (value) => {
    const raw = Buffer.from(value);
    const result = inject(raw);
    expect(result.instrumented).toBe(false);
    expect(result.bytes).toBe(raw);
    expect(result.bytes.equals(Buffer.from(value))).toBe(true);
  });

  it.each([
    "script-src 'none'",
    "default-src 'self'",
    "script-src 'self' 'nonce-secret' 'unsafe-inline'",
    "script-src 'unsafe-inline' 'sha256-YWJj'",
    "script-src 'unsafe-inline' 'strict-dynamic'",
    "script-src 'unsafe-inline'; script-src-elem 'none'",
    "sandbox allow-forms; script-src 'unsafe-inline'",
    "script-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "script-src 'unsafe-inline', default-src *",
  ])('preserves all bytes under an enforcing inline restriction: %s', (policy) => {
    const raw = Buffer.from(html);
    const result = inject(raw, [policy]);
    expect(result.instrumented).toBe(false);
    expect(result.reason).toBe('csp');
    expect(result.bytes).toBe(raw);
  });

  it('requires every policy and uses actual script-src-elem/script/default precedence', () => {
    expect(
      inject(html, [
        "default-src 'none'; script-src 'unsafe-inline'",
        "sandbox allow-scripts; frame-ancestors 'self'",
      ]).instrumented
    ).toBe(true);
    expect(inject(html, ["script-src 'none'; script-src-elem 'unsafe-inline'"]).instrumented).toBe(
      true
    );
    expect(inject(html, ["script-src 'unsafe-inline'", "default-src 'self'"]).instrumented).toBe(
      false
    );
    // The caller passes enforcing headers only: report-only is kept on the response.
    expect(inject(html, []).instrumented).toBe(true);
    expect(
      inject(
        html,
        Array.from({ length: 33 }, () => "script-src 'unsafe-inline'")
      ).instrumented
    ).toBe(false);
  });

  it.each([
    'text/html; charset=latin1',
    'text/html; charset=utf8; charset=utf8',
    'text/plain',
    'text/html; charset="utf-8"; other=unknown',
  ])('refuses unsupported or ambiguous content type: %s', (contentType) => {
    const raw = Buffer.from(html);
    const result = inject(raw, [], contentType);
    expect(result.bytes).toBe(raw);
    expect(result.reason).toBe('encoding');
  });

  it('keeps invalid UTF8 and oversized original bytes without decoding or replacement', () => {
    for (const raw of [
      Buffer.from([0xff, 0xfe, 0x3c, 0x68]),
      Buffer.alloc(WORKBENCH.PREVIEW_HTML_INJECT_MAX_BYTES + 1, 0xff),
    ]) {
      const result = inject(raw);
      expect(result.instrumented).toBe(false);
      expect(result.bytes).toBe(raw);
    }
  });

  it('accepts exact cap input and rejects cap+1 rather than partially rewriting it', () => {
    const start = '<html><head></head><body>';
    const end = '</body></html>';
    const raw = Buffer.from(
      start + 'x'.repeat(WORKBENCH.PREVIEW_HTML_INJECT_MAX_BYTES - start.length - end.length) + end
    );
    expect(inject(raw).instrumented).toBe(true);
    expect(inject(Buffer.concat([raw, Buffer.from('x')])).reason).toBe('oversize');
  });
});

describe('complete ASCII policy/meta refusal boundaries', () => {
  const ascii = Array.from({ length: 128 }, (_, code) => code);
  it.each(ascii)('preserves policy control/refusal grammar for ASCII %i', (code) => {
    const character = String.fromCharCode(code);
    const original = Buffer.from(html);
    const expectedRefusal =
      code <= 8 || code === 11 || (code >= 14 && code <= 31) || code === 127 || code === 44;
    const result = inject(original, [
      `script-src 'unsafe-inline'; x-note prefix${character}suffix`,
    ]);
    expect(result.instrumented).toBe(!expectedRefusal);
    if (expectedRefusal) expect(result.bytes).toBe(original);
    else
      expect(result.bytes.toString()).toBe(
        html.replace(
          '<head>',
          `<head><script>${DOC_FRAME_SHIM_SCRIPT}</script><script>${DEVTOOLS_AGENT_SCRIPT}</script>`
        )
      );
  });
  it.each(ascii)('preserves meta attribute controls/entity refusal for ASCII %i', (code) => {
    const character = String.fromCharCode(code);
    const quote = code === 34 ? "'" : '"';
    const markup = `<html><head><meta name="viewport" content=${quote}prefix${character}suffix${quote}></head><body></body></html>`;
    const original = Buffer.from(markup);
    const expectedRefusal = code <= 31 || code === 38;
    const result = inject(original);
    expect(result.instrumented).toBe(!expectedRefusal);
    if (expectedRefusal) expect(result.bytes).toBe(original);
    else
      expect(result.bytes.toString()).toBe(
        markup.replace(
          '<head>',
          `<head><script>${DOC_FRAME_SHIM_SCRIPT}</script><script>${DEVTOOLS_AGENT_SCRIPT}</script>`
        )
      );
  });
});

describe('the body is the page’s own business (DOR-3131)', () => {
  const ADDITION = `<script>${DOC_FRAME_SHIM_SCRIPT}</script><script>${DEVTOOLS_AGENT_SCRIPT}</script>`;
  const page = (body: string, headExtra = '') =>
    `<!doctype html><html><head><meta charset="utf-8"><title>Icons</title>${headExtra}</head><body>${body}</body></html>`;

  it('adds the scripts right after <head> on a page with hundreds of inline SVG icons', () => {
    const icon = (n: number) =>
      `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M${n} 0L24 24"/><circle cx="12" cy="12" r="4" /><use href="#i${n}"/></svg>`;
    const value = page(Array.from({ length: 300 }, (_, n) => icon(n)).join('\n'));
    const result = inject(value);
    expect(result.instrumented).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.bytes.toString()).toBe(value.replace('<head>', `<head>${ADDITION}`));
  });

  it.each([
    ['an iframe', '<iframe src="https://example.com"><head></head></iframe>'],
    ['a template', '<template><head></head><script>later()</script></template>'],
    ['MathML', '<math><mi>x</mi><mspace width="1em"/></math>'],
    ['noscript', '<noscript><img src="pixel.gif"><head></head></noscript>'],
    ['plaintext', '<plaintext><head></head>'],
    ['xmp, noembed and noframes', '<xmp><b></xmp><noembed>x</noembed><noframes>y</noframes>'],
    ['a stray </head> and a second <head>', '</head><head></head>'],
    [
      'a body <meta> policy, which browsers ignore outside the head',
      '<meta http-equiv="content-security-policy" content="script-src \'none\'">',
    ],
    ['a body charset that the header already overrides', '<meta charset="iso-8859-1">'],
    ['malformed tags', '<div class="unterminated><svg/><p>'],
    ['a script whose string names </head>', '<script>const s = "</head><svg>";</script>'],
  ])('adds the scripts when the body holds %s', (_label, body) => {
    const value = page(body);
    const result = inject(value);
    expect(result.instrumented).toBe(true);
    expect(result.bytes.toString()).toBe(value.replace('<head>', `<head>${ADDITION}`));
  });

  it.each([
    ['text right after </head>', '<html><head></head>Hello <svg/></html>'],
    ['an implicit body opened by <svg>', '<html><head></head><svg><path/></svg></html>'],
    ['an implicit body opened by <noscript>', '<html><head></head><noscript></noscript></html>'],
    [
      'a head-bound <script> between </head> and <body>',
      '<html><head></head><script>x()</script><body><svg/></body></html>',
    ],
  ])('adds the scripts with %s', (_label, value) => {
    expect(inject(value).instrumented).toBe(true);
  });

  it('never moves the insertion point: the scripts are the first thing in the head', () => {
    const value = page(
      '<svg><head></head><script>/* svg script */</script></svg>',
      '<script>user()</script>'
    );
    const out = inject(value).bytes.toString();
    expect(out.indexOf(ADDITION)).toBe(value.indexOf('<head>') + '<head>'.length);
    expect(out.indexOf(ADDITION)).toBeLessThan(out.indexOf('user()'));
  });

  it.each([
    ['<html><body>headless</body></html>', 'no-head'],
    ['<div>fragment</div>', 'no-head'],
    ['', 'no-head'],
    ['<svg></svg><html><head></head><body></body></html>', 'markup'],
    ['<html><head><noscript></noscript></head><body></body></html>', 'markup'],
    ['<html><head><template></template></head><body></body></html>', 'markup'],
    ['<html><head><title>never closed</head></html>', 'markup'],
    [
      '<html><head><script>var s = "</head><body>";</script><noscript></noscript></head><body></body></html>',
      'markup',
    ],
    // Read as markup, the script text would close the head and open the body.
    [
      '<html><head><script></head><body></script><noscript></noscript></head><body></body></html>',
      'markup',
    ],
    [
      '<html><head><style></head><body></style><template></template></head><body></body></html>',
      'markup',
    ],
    ['<html><head><meta http-equiv="refresh" content="0;url=/x"></head></html>', 'markup'],
    ['<html><head></head><head></head></html>', 'markup'],
    [
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src *"></head></html>',
      'csp',
    ],
    [
      '<html><head></head><meta http-equiv="content-security-policy" content="x"><body></body></html>',
      'csp',
    ],
    ['<html><head><meta charset="iso-8859-1"></head></html>', 'encoding'],
  ])('names the refusal with a stable code: %s → %s', (value, code) => {
    const raw = Buffer.from(value);
    const result = inject(raw);
    expect(result.instrumented).toBe(false);
    expect(result.reason).toBe(code);
    expect(result.bytes).toBe(raw);
  });

  it('names a header policy, an encoding and the size cap with their own codes', () => {
    expect(inject(html, ["script-src 'self'"]).reason).toBe('csp');
    expect(inject(html, [], 'text/html; charset=latin1').reason).toBe('encoding');
    expect(inject(Buffer.alloc(WORKBENCH.PREVIEW_HTML_INJECT_MAX_BYTES + 1, 0x20)).reason).toBe(
      'oversize'
    );
  });
});
