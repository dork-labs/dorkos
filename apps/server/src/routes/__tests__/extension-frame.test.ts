/**
 * The document every app's screens run in (DOR-3293): DorkOS's own response
 * and policy, never a `srcdoc` that inherits the shell's `'unsafe-inline'`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/trusted-origins.js', () => ({
  resolveAuthTrustedOrigins: () => ['http://localhost:6241'],
}));

import { createExtensionFrameRoutes } from '../extension-frame.js';

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
    expect(csp).toContain("frame-ancestors 'self' http://localhost:6241");
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
