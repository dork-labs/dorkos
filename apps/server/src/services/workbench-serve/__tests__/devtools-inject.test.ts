import { describe, it, expect } from 'vitest';
import { injectDevtoolsScript, DEVTOOLS_AGENT_SCRIPT } from '../devtools-inject.js';
import { serializeConsoleArg } from '../devtools-shim.js';

describe('DEVTOOLS_AGENT_SCRIPT — the injected shim source', () => {
  it('never references /api anywhere (the load-bearing security guarantee)', () => {
    // The shim runs in an opaque-origin frame and must talk ONLY to window.parent
    // via postMessage — a stray `/api/...` would imply a credentialed path it must
    // never have.
    expect(DEVTOOLS_AGENT_SCRIPT).not.toContain('/api');
  });

  it('is a self-contained IIFE that parses as valid JavaScript', () => {
    expect(DEVTOOLS_AGENT_SCRIPT.trimStart().startsWith('(')).toBe(true);
    // Throws a SyntaxError if the toString-embedded source is malformed.
    expect(() => new Function(DEVTOOLS_AGENT_SCRIPT)).not.toThrow();
  });

  it('talks to the parent via postMessage and installs console/network/error hooks', () => {
    expect(DEVTOOLS_AGENT_SCRIPT).toContain('postMessage');
    expect(DEVTOOLS_AGENT_SCRIPT).toContain('__dorkosDevtools');
    expect(DEVTOOLS_AGENT_SCRIPT).toContain('unhandledrejection');
  });
});

describe('injectDevtoolsScript — first-head-child insertion', () => {
  const SCRIPT = /<script>.*__dorkosDevtools.*<\/script>/s;

  it('inserts immediately after <head>', () => {
    const out = injectDevtoolsScript('<html><head><title>t</title></head><body>x</body></html>');
    expect(out).toMatch(/<head><script>/);
    // The shim precedes the page's own first head child.
    expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('<title>'));
    expect(out).toMatch(SCRIPT);
  });

  it('is case-insensitive to <HEAD>', () => {
    const out = injectDevtoolsScript('<HTML><HEAD><title>t</title></HEAD><body></body></HTML>');
    expect(out).toMatch(/<HEAD><script>/);
  });

  it('handles attributes on the head tag', () => {
    const out = injectDevtoolsScript('<head data-x="y"><meta></head>');
    expect(out).toMatch(/<head data-x="y"><script>/);
  });

  it('injects a <head> after <html> when the document has no head', () => {
    const out = injectDevtoolsScript('<html><body><h1>hi</h1></body></html>');
    expect(out).toMatch(/<html><head><script>.*<\/script><\/head>/s);
    expect(out).toContain('<h1>hi</h1>');
  });

  it('prepends after a leading doctype when there is no head or html tag', () => {
    const out = injectDevtoolsScript('<!doctype html>\n<body>hi</body>');
    // The doctype must stay first; the script comes right after it (never nested
    // inside a second, wrapping doctype).
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toMatch(/<!doctype html>\s*<script>/s);
    expect((out.match(/<!doctype/gi) ?? []).length).toBe(1);
  });

  it('prepends the script for a bare fragment (no doctype/head/html)', () => {
    const out = injectDevtoolsScript('<div>fragment</div>');
    expect(out.startsWith('<script>')).toBe(true);
    expect(out).toContain('<div>fragment</div>');
  });
});

describe('serializeConsoleArg — safe console serialization', () => {
  it('passes primitives through', () => {
    expect(serializeConsoleArg(42)).toBe(42);
    expect(serializeConsoleArg(true)).toBe(true);
    expect(serializeConsoleArg(null)).toBe(null);
    expect(serializeConsoleArg('hi')).toBe('hi');
  });

  it('renders non-clonable primitives descriptively', () => {
    expect(serializeConsoleArg(undefined)).toBe('[undefined]');
    expect(serializeConsoleArg(10n)).toBe('10n');
    expect(serializeConsoleArg(function foo() {})).toBe('[Function foo]');
    expect(String(serializeConsoleArg(Symbol('s')))).toContain('Symbol');
  });

  it('truncates long strings', () => {
    const out = serializeConsoleArg('a'.repeat(20), 4, 50, 8) as string;
    expect(out.startsWith('aaaaaaaa')).toBe(true);
    expect(out).toContain('[truncated]');
  });

  it('is circular-safe', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = serializeConsoleArg(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('caps depth', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const out = serializeConsoleArg(deep, 2) as Record<string, unknown>;
    // Beyond maxDepth the value is summarized, never walked infinitely.
    expect(JSON.stringify(out)).toContain('[Object]');
  });

  it('caps array items and notes the remainder', () => {
    const arr = Array.from({ length: 10 }, (_, i) => i);
    const out = serializeConsoleArg(arr, 4, 3) as unknown[];
    expect(out.length).toBe(4); // 3 items + a "…(N more)" marker
    expect(String(out[3])).toContain('more');
  });

  it('preserves Error name/message/stack', () => {
    const err = new TypeError('boom');
    const out = serializeConsoleArg(err) as { name: string; message: string; stack?: string };
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('boom');
    expect(typeof out.stack).toBe('string');
  });
});
