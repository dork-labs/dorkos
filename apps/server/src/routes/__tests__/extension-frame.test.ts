/**
 * The document every app's screens run in (DOR-3293): DorkOS's own response
 * and policy, never a `srcdoc` that inherits the shell's `'unsafe-inline'`.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { resolveAuthTrustedOrigins } from '../../lib/trusted-origins.js';
import { createExtensionFrameRoutes, frameBootstrap } from '../extension-frame.js';

async function load() {
  const res = await createExtensionFrameRoutes().request('/');
  const csp = res.headers.get('Content-Security-Policy') ?? '';
  const html = await res.text();
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
  return { res, csp, html, nonce };
}

describe('GET /api/extension-frame', () => {
  it('sandboxes the document in its own header, scripts only, whatever the iframe says', async () => {
    const { res, csp } = await load();
    expect(res.status).toBe(200);
    const directives = csp.split(';').map((part) => part.trim());
    expect(directives).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toMatch(/allow-(forms|popups|downloads|top-navigation|modals)/);
  });

  it('runs only scripts carrying a fresh nonce, never inline or blob: code', async () => {
    const first = await load();
    const second = await load();
    expect(first.nonce).toBeDefined();
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.csp).not.toContain("'unsafe-inline'; ");
    expect(first.csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(first.csp).not.toMatch(/script-src[^;]*blob:/);
    expect(first.csp).not.toContain("'unsafe-eval'");
    // The one script on the page is the bootstrap, under this response's nonce.
    expect(first.html.match(/<script/g)).toHaveLength(1);
    expect(first.html).toContain(`<script nonce="${first.nonce}">`);
  });

  it('reaches no network and can be framed only by DorkOS', async () => {
    const { csp } = await load();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    // Framed only by this page and the origins DorkOS already trusts, never a wildcard.
    const ancestors = csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('frame-ancestors '));
    expect(ancestors).toBe(`frame-ancestors 'self' ${resolveAuthTrustedOrigins().join(' ')}`);
    expect(resolveAuthTrustedOrigins().length).toBeGreaterThan(0);
    expect(ancestors).not.toContain('*');
  });

  it('allows blob: pictures and media, and nothing else new', async () => {
    const { csp } = await load();
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toContain('media-src blob:');
  });

  it('carries no app code or data, and is never cached', async () => {
    const { res, html } = await load();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // The bootstrap takes the runtime from the parent window only, once.
    expect(html).toContain('event.source !== parent');
    expect(html).toContain("removeEventListener('message', boot)");
  });
});

const DORKOS = 'http://localhost:4242';

/** Run the bootstrap in a bare global the way the frame would, and drive its messages. */
function runBootstrap() {
  const listeners = new Set<(event: unknown) => void>();
  const appended: { nonce: string; textContent: string }[] = [];
  const parentWindow = {};
  const frameGlobal: Record<string, unknown> = {
    document: {
      currentScript: { nonce: 'load-nonce' },
      createElement: () => ({ nonce: '', textContent: '' }),
      head: { append: (element: { nonce: string; textContent: string }) => appended.push(element) },
    },
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.delete(listener),
    parent: parentWindow,
  };
  vm.createContext(frameGlobal);
  vm.runInContext(frameBootstrap([DORKOS]), frameGlobal);
  const send = (event: Record<string, unknown>) => {
    for (const listener of [...listeners]) listener(event);
  };
  const runtimeMessage = (overrides: Record<string, unknown> = {}) => ({
    source: parentWindow,
    origin: DORKOS,
    data: { type: 'dorkos-frame-runtime', runtime: 'runtime code' },
    ...overrides,
  });
  return { frameGlobal, appended, listeners, send, runtimeMessage };
}

describe('the frame bootstrap', () => {
  it('runs the runtime once, as a script carrying the load nonce, then stops listening', () => {
    const frame = runBootstrap();
    frame.send(frame.runtimeMessage());
    expect(frame.appended).toEqual([{ nonce: 'load-nonce', textContent: 'runtime code' }]);
    expect(frame.listeners.size).toBe(0);
    expect(frame.frameGlobal.__dorkosFrameParentOrigin).toBe(DORKOS);
    // A second runtime is ignored, even from the same window and origin.
    frame.send(frame.runtimeMessage({ data: { type: 'dorkos-frame-runtime', runtime: 'second' } }));
    expect(frame.appended).toHaveLength(1);
  });

  it('refuses code from any other window', () => {
    const frame = runBootstrap();
    frame.send(frame.runtimeMessage({ source: {} }));
    expect(frame.appended).toEqual([]);
    expect(frame.listeners.size).toBe(1);
  });

  it('refuses code from the parent window when it comes from an origin that is not DorkOS', () => {
    const frame = runBootstrap();
    frame.send(frame.runtimeMessage({ origin: 'https://evil.example' }));
    frame.send(frame.runtimeMessage({ origin: 'null' }));
    expect(frame.appended).toEqual([]);
    expect(frame.frameGlobal.__dorkosFrameParentOrigin).toBeUndefined();
  });

  it('refuses a message that is not a runtime', () => {
    const frame = runBootstrap();
    frame.send(frame.runtimeMessage({ data: { type: 'dorkos-frame-runtime', runtime: 42 } }));
    frame.send(frame.runtimeMessage({ data: { type: 'other', runtime: 'x' } }));
    expect(frame.appended).toEqual([]);
  });

  it('never evaluates text: no eval or Function anywhere in the bootstrap', () => {
    const source = frameBootstrap([DORKOS]);
    expect(source).not.toMatch(/\beval\s*\(|\bFunction\s*\(/);
  });

  it('cannot be closed early by a hostile origin string', () => {
    expect(frameBootstrap(['http://a</script><script>x'])).not.toContain('</script>');
  });
});
