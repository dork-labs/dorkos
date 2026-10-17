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
    '<html><head></head><body><meta http-equiv="content-security-policy" content="script-src none"></body></html>',
    '<html><head><meta http-equiv="content&#45;security-policy" content="script-src none"></head></html>',
    '<html><head><meta charset="iso-8859-1"></head></html>',
    '<html><head><meta charset="utf-8"><meta charset="utf8"></head></html>',
    '<html><head><meta charset="utf-8" CHARSET="utf8"></head></html>',
    '<html><head><meta http-equiv="refresh" content="0;url=/other"></head></html>',
    '<!-- <head> --!><html><head></head></html>',
    '<html><head></head><head></head></html>',
    '<html><head><title>never closed</head></html>',
    '<!DOCTYPE html PUBLIC "unknown"><html><head></head></html>',
    '<html><head></head><body><svg><head></head></svg></body></html>',
    '<html><head></head><body><template><head></head></template></body></html>',
    '<html><head><noscript><meta charset="utf8"></noscript></head></html>',
    '<html><head><script><!-- <script>double escaped</script></script></head></html>',
    '<html><head>implicit head closing<script>page()</script></head></html>',
    '<html><head data-x="never closed></head></html>',
    '<html><head/></html>',
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
