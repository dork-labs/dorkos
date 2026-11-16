import { describe, it, expect } from 'vitest';
import {
  classifyBrowserTarget,
  loopbackStrategy,
  WORKBENCH_SANDBOX_ISOLATED,
  WORKBENCH_SANDBOX_EXTERNAL,
} from '../browser-url';

// Classification decides how each target is loaded — and therefore its sandbox
// posture. The security-critical invariant: served/proxied (untrusted local)
// content must NOT get `allow-same-origin`.

describe('classifyBrowserTarget', () => {
  it('routes a loopback dev-server URL through the proxy, carrying its host, port and path', () => {
    expect(classifyBrowserTarget('http://localhost:5173/app')).toEqual({
      mode: 'proxy',
      hostname: 'localhost',
      port: 5173,
      path: '/app',
    });
    expect(classifyBrowserTarget('http://127.0.0.1:3000/')).toMatchObject({
      mode: 'proxy',
      hostname: '127.0.0.1',
      port: 3000,
    });
  });

  it('treats every spelling of "this machine" as loopback, including 0.0.0.0', () => {
    // 0.0.0.0 is the one the server's trusted-origins deliberately calls public.
    // Here the question is where the BROWSER goes, and it goes to itself.
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'app.localhost']) {
      expect(classifyBrowserTarget(`http://${host}:4242/`)).toMatchObject({
        mode: 'proxy',
        hostname: host,
        port: 4242,
      });
    }
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

  it('reads about:blank as a new empty page, framed as nothing', () => {
    expect(classifyBrowserTarget('about:blank')).toEqual({ mode: 'blank' });
  });

  it('blocks script/URI-smuggling protocols', () => {
    expect(classifyBrowserTarget('javascript:alert(1)')).toEqual({ mode: 'blocked' });
    expect(classifyBrowserTarget('data:text/html,<h1>x</h1>')).toEqual({ mode: 'blocked' });
  });
});

describe('loopbackStrategy', () => {
  // "localhost" means the machine looking at the page. So a dev server can be
  // framed by its own URL only when the page itself is on that machine.
  it('frames directly when the cockpit is open on the machine running the dev server', () => {
    expect(loopbackStrategy('localhost')).toBe('direct');
    expect(loopbackStrategy('127.0.0.1')).toBe('direct');
    expect(loopbackStrategy('[::1]')).toBe('direct');
    expect(loopbackStrategy('app.localhost')).toBe('direct');
  });

  it('goes through the server when the cockpit is open on another device', () => {
    // A phone on Tailscale, a tunnel, a LAN address: "localhost" there is the
    // viewer's own device, which is not running the dev server.
    expect(loopbackStrategy('machine.tail.ts.net')).toBe('server');
    expect(loopbackStrategy('192.168.1.20')).toBe('server');
    expect(loopbackStrategy('demo.ngrok.app')).toBe('server');
  });
});

describe('sandbox posture', () => {
  it('locally served files NEVER carry allow-same-origin (opaque origin)', () => {
    expect(WORKBENCH_SANDBOX_ISOLATED).not.toContain('allow-same-origin');
    expect(WORKBENCH_SANDBOX_ISOLATED).toContain('allow-scripts');
  });

  it('external content keeps allow-same-origin (it lives on its own origin)', () => {
    expect(WORKBENCH_SANDBOX_EXTERNAL).toContain('allow-same-origin');
  });
});
