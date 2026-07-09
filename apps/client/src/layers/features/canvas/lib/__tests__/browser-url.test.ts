import { describe, it, expect } from 'vitest';
import {
  classifyBrowserTarget,
  normalizeAddressInput,
  WORKBENCH_SANDBOX_ISOLATED,
  WORKBENCH_SANDBOX_EXTERNAL,
} from '../browser-url';

// Classification decides how each target is loaded — and therefore its sandbox
// posture. The security-critical invariant: served/proxied (untrusted local)
// content must NOT get `allow-same-origin`.

describe('classifyBrowserTarget', () => {
  it('routes a loopback dev-server URL through the proxy, carrying its port and path', () => {
    expect(classifyBrowserTarget('http://localhost:5173/app')).toEqual({
      mode: 'proxy',
      port: 5173,
      path: '/app',
    });
    expect(classifyBrowserTarget('http://127.0.0.1:3000/')).toMatchObject({
      mode: 'proxy',
      port: 3000,
    });
  });

  it('treats a non-loopback http(s) site as external (framed directly)', () => {
    expect(classifyBrowserTarget('https://example.com/docs')).toEqual({
      mode: 'external',
      url: 'https://example.com/docs',
    });
  });

  it('routes a file: URL and a bare local path through the static-serve route', () => {
    expect(classifyBrowserTarget('file:///proj/dist/index.html')).toEqual({
      mode: 'serve',
      path: '/proj/dist/index.html',
    });
    expect(classifyBrowserTarget('dist/preview.html')).toEqual({
      mode: 'serve',
      path: 'dist/preview.html',
    });
  });

  it('blocks script/URI-smuggling protocols', () => {
    expect(classifyBrowserTarget('javascript:alert(1)')).toEqual({ mode: 'blocked' });
    expect(classifyBrowserTarget('data:text/html,<h1>x</h1>')).toEqual({ mode: 'blocked' });
  });
});

describe('sandbox posture', () => {
  it('served/proxied content NEVER carries allow-same-origin (opaque origin)', () => {
    expect(WORKBENCH_SANDBOX_ISOLATED).not.toContain('allow-same-origin');
    expect(WORKBENCH_SANDBOX_ISOLATED).toContain('allow-scripts');
  });

  it('external content keeps allow-same-origin (it lives on its own origin)', () => {
    expect(WORKBENCH_SANDBOX_EXTERNAL).toContain('allow-same-origin');
  });
});

describe('normalizeAddressInput', () => {
  it('adds https:// to a bare public host', () => {
    expect(normalizeAddressInput('example.com')).toBe('https://example.com');
  });

  it('adds http:// to a bare loopback host (dev servers are plain http)', () => {
    expect(normalizeAddressInput('localhost:3000')).toBe('http://localhost:3000');
  });

  it('leaves an explicit scheme or a local path untouched', () => {
    expect(normalizeAddressInput('https://a.test')).toBe('https://a.test');
    expect(normalizeAddressInput('./index.html')).toBe('./index.html');
  });
});
