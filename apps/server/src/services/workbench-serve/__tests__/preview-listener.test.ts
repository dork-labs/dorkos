/**
 * The preview listener puts a network-reachable port in front of a service that
 * expects only local callers, so most of what follows is about the cookie that
 * keeps the two apart: what happens without it, with the wrong one, and with an
 * expired one. The rest is about being an honest proxy — every method, both
 * directions, WebSockets included, and framing headers gone.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PreviewListenerManager,
  PreviewPortExhaustedError,
  previewCookieName,
  rewriteUpstreamLocation,
} from '../preview-listener.js';
import { WorkbenchTokenSigner } from '../token.js';

const signer = new WorkbenchTokenSigner({ secret: 'preview-listener-test-secret' });

/** Every request the fake dev server saw, so a test can prove it saw none. */
let seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

let upstream: http.Server;
let upstreamPort: number;
let wss: WebSocketServer;

/** Managers opened during a test, closed after it whatever happened. */
const opened: PreviewListenerManager[] = [];

function manage(options?: Partial<ConstructorParameters<typeof PreviewListenerManager>[0]>) {
  const manager = new PreviewListenerManager({
    host: '127.0.0.1',
    signer,
    ...options,
  });
  opened.push(manager);
  return manager;
}

/** A tiny HTTP client that keeps the raw response, headers included. */
async function fetchPreview(
  listenPort: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: listenPort,
        path,
        method: init.method ?? 'GET',
        // Length is explicit because Node's client omits chunked framing for
        // DELETE, and an unframed body would be parsed as a second request.
        headers: {
          ...init.headers,
          ...(init.body === undefined
            ? {}
            : { 'content-length': String(Buffer.byteLength(init.body)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const url = req.url ?? '/';
      if (url.startsWith('/app.css')) {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end('body{color:red}');
        return;
      }
      if (url.startsWith('/latin1.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
        res.end('<html><head></head><body>caf\xe9</body></html>');
        return;
      }
      if (url.startsWith('/sets-cookies')) {
        res.setHeader('Set-Cookie', [
          'better-auth.session_token=planted; Path=/',
          '__Secure-better-auth-session_token=planted-legacy; Path=/',
          `dorkos_preview_${Number(req.headers.host?.split(':')[1] ?? 0)}=hijack; Path=/`,
          'dorkos_preview_1=hijack-any; Path=/',
          'my_app_session=keep-me; Path=/',
          'theme=dark; Path=/',
        ]);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (url.startsWith('/huge.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // Comfortably past the 5 MB instrumentation cap.
        res.end(`<html><head></head><body>${'x'.repeat(6 * 1024 * 1024)}</body></html>`);
        return;
      }
      if (url.startsWith('/echo')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString('utf8') })
        );
        return;
      }
      if (url.startsWith('/redirect-absolute')) {
        res.writeHead(302, { Location: `http://localhost:${upstreamPort}/landed` });
        res.end();
        return;
      }
      if (url.startsWith('/redirect-elsewhere')) {
        res.writeHead(302, { Location: 'https://example.com/landed' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
      });
      res.end('<html><head><title>dev</title></head><body>hi</body></html>');
    });
  });
  wss = new WebSocketServer({ server: upstream, path: '/hmr' });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => socket.send(`echo:${String(data)}`));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  // Terminate first: `close()` waits on every live socket, and these tests
  // deliberately leave live ones behind.
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(async () => {
  seen = [];
  await Promise.all(opened.splice(0).map((m) => m.close()));
});

/** Open a listener and bootstrap it, returning the cookie the browser would hold. */
async function bootstrapped(targetPort = upstreamPort, path = '/') {
  const manager = manage();
  const { listenPort } = await manager.acquire(targetPort);
  const token = signer.mint({ kind: 'proxy', port: targetPort });
  const res = await fetchPreview(
    listenPort,
    `${path}${path.includes('?') ? '&' : '?'}__dorkos_preview=${token}`
  );
  const setCookie = res.headers['set-cookie']?.[0] ?? '';
  const cookie = setCookie.split(';')[0];
  return { manager, listenPort, token, bootstrap: res, cookie };
}

describe('PreviewListenerManager — authorization', () => {
  it('answers the health probe with 204, no cookie, and never asks the dev server', async () => {
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);

    const res = await fetchPreview(listenPort, '/__dorkos_preview/health');

    expect(res.status).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['set-cookie']).toBeUndefined();
    // The whole point of an unauthenticated endpoint is that it reveals nothing.
    expect(seen).toEqual([]);
  });

  it('turns the bootstrap token into a cookie and redirects the token out of the URL', async () => {
    const { listenPort, token, bootstrap } = await bootstrapped(upstreamPort, '/deep/route');

    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers.location).toBe('/deep/route');
    expect(bootstrap.headers['referrer-policy']).toBe('no-referrer');
    const setCookie = bootstrap.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${previewCookieName(listenPort)}=${token}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    // Not one byte reached the dev server on the way through.
    expect(seen).toEqual([]);
  });

  it('keeps a query string across the bootstrap redirect', async () => {
    const { bootstrap } = await bootstrapped(upstreamPort, '/deep/route?tab=2');
    expect(bootstrap.headers.location).toBe('/deep/route?tab=2');
  });

  it('refuses a request with no cookie, and forwards nothing', async () => {
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);

    const res = await fetchPreview(listenPort, '/');

    expect(res.status).toBe(401);
    expect(res.body).toContain('This preview link has expired');
    expect(seen).toEqual([]);
  });

  it('refuses an expired cookie', async () => {
    const expiring = new WorkbenchTokenSigner({ secret: 'preview-listener-test-secret', ttlMs: 1 });
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);
    const token = expiring.mint({ kind: 'proxy', port: upstreamPort });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res = await fetchPreview(listenPort, '/', {
      headers: { cookie: `${previewCookieName(listenPort)}=${token}` },
    });

    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('refuses a token minted for a different dev server', async () => {
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);
    const wrongTarget = signer.mint({ kind: 'proxy', port: upstreamPort + 1 });

    const bootstrap = await fetchPreview(listenPort, `/?__dorkos_preview=${wrongTarget}`);
    const cookied = await fetchPreview(listenPort, '/', {
      headers: { cookie: `${previewCookieName(listenPort)}=${wrongTarget}` },
    });

    expect(bootstrap.status).toBe(401);
    expect(cookied.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('refuses a serve-scoped token', async () => {
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);
    const serveToken = signer.mint({ kind: 'serve', cwd: '/tmp' });

    const res = await fetchPreview(listenPort, `/?__dorkos_preview=${serveToken}`);

    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('refuses another listener‘s cookie, because the name carries the listen port', async () => {
    const manager = manage();
    const first = await manager.acquire(upstreamPort);
    const token = signer.mint({ kind: 'proxy', port: upstreamPort });

    const res = await fetchPreview(first.listenPort, '/', {
      headers: { cookie: `${previewCookieName(first.listenPort + 1)}=${token}` },
    });

    expect(res.status).toBe(401);
  });

  it('never writes the token to the log', async () => {
    const lines: unknown[] = [];
    const recorder = {
      info: (m: string, d?: unknown) => lines.push(m, d),
      warn: (m: string, d?: unknown) => lines.push(m, d),
      error: (m: string, d?: unknown) => lines.push(m, d),
    };
    const manager = manage({ logger: recorder });
    const { listenPort } = await manager.acquire(upstreamPort);
    const token = signer.mint({ kind: 'proxy', port: upstreamPort });
    await fetchPreview(listenPort, `/?__dorkos_preview=${token}`);
    await manager.close();

    expect(JSON.stringify(lines)).not.toContain(token);
  });
});

describe('PreviewListenerManager — proxying', () => {
  it('forwards every method, with its body, and relays the answer', async () => {
    const { listenPort, cookie } = await bootstrapped();

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetchPreview(listenPort, '/echo', {
        method,
        headers: { cookie, 'content-type': 'text/plain' },
        body: method === 'GET' ? undefined : `payload-${method}`,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        method,
        body: method === 'GET' ? '' : `payload-${method}`,
      });
    }
  });

  it('gives the dev server its own name in the Host header', async () => {
    const { listenPort, cookie } = await bootstrapped();
    await fetchPreview(listenPort, '/echo', { headers: { cookie } });
    expect(seen.at(-1)?.headers.host).toBe(`localhost:${upstreamPort}`);
  });

  it('strips the framing guards so the page can be embedded', async () => {
    const { listenPort, cookie } = await bootstrapped();

    const res = await fetchPreview(listenPort, '/', { headers: { cookie } });

    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe("default-src 'self'");
  });

  it('injects the DevTools shim into HTML and leaves everything else alone', async () => {
    const { listenPort, cookie } = await bootstrapped();

    const html = await fetchPreview(listenPort, '/', { headers: { cookie } });
    const css = await fetchPreview(listenPort, '/app.css', { headers: { cookie } });
    const latin1 = await fetchPreview(listenPort, '/latin1.html', { headers: { cookie } });

    expect(html.body).toContain('__dorkosDevtools');
    expect(html.body.indexOf('<script>')).toBeLessThan(html.body.indexOf('<title>'));
    expect(css.body).toBe('body{color:red}');
    // A page that declares another charset relays untouched rather than being
    // mis-decoded into mojibake.
    expect(latin1.body).not.toContain('__dorkosDevtools');
  });

  it('keeps a redirect to the dev server inside the preview origin', async () => {
    const { listenPort, cookie } = await bootstrapped();

    const own = await fetchPreview(listenPort, '/redirect-absolute', { headers: { cookie } });
    const elsewhere = await fetchPreview(listenPort, '/redirect-elsewhere', {
      headers: { cookie },
    });

    expect(own.status).toBe(302);
    expect(own.headers.location).toBe('/landed');
    expect(elsewhere.headers.location).toBe('https://example.com/landed');
  });

  it('never hands the dev server DorkOS‘s own cookies', async () => {
    const { listenPort, cookie } = await bootstrapped();

    await fetchPreview(listenPort, '/echo', {
      headers: {
        cookie: `${cookie}; better-auth.session_token=secret-session; app_pref=dark`,
      },
    });

    const forwarded = seen.at(-1)?.headers.cookie ?? '';
    expect(forwarded).toContain('app_pref=dark');
    expect(forwarded).not.toContain('secret-session');
    expect(forwarded).not.toContain('dorkos_preview_');
  });

  it('relays an oversized HTML page uninstrumented rather than holding it all', async () => {
    const { listenPort, cookie } = await bootstrapped();

    const res = await fetchPreview(listenPort, '/huge.html', { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(5 * 1024 * 1024);
    // Whole and unaltered — just not instrumented.
    expect(res.body).toContain('</body></html>');
    expect(res.body).not.toContain('__dorkosDevtools');
  });

  it('drops every Better Auth cookie spelling, and nothing that merely resembles one', async () => {
    const { listenPort, cookie } = await bootstrapped();

    await fetchPreview(listenPort, '/echo', {
      headers: {
        cookie: [
          cookie,
          'better-auth.session_token=secret-session',
          'better-auth.session_data.0=secret-chunk',
          '__Secure-better-auth.session_token=secret-secure',
          'better-auth.state=secret-state',
          // The library still reads this hyphen spelling as a compat fallback,
          // so a cookie an older install left behind is a live credential.
          'better-auth-session_token=secret-legacy',
          '__Secure-better-auth-session_token=secret-legacy-secure',
          // A dev app's own cookie that a substring search would have eaten.
          'my-better-auth-notes=keep-me',
          'app_pref=dark',
        ].join('; '),
      },
    });

    const forwarded = seen.at(-1)?.headers.cookie ?? '';
    expect(forwarded).not.toContain('secret-');
    expect(forwarded).not.toContain('dorkos_preview_');
    expect(forwarded).toContain('my-better-auth-notes=keep-me');
    expect(forwarded).toContain('app_pref=dark');
  });

  it('never lets a dev server set a DorkOS cookie in the browser', async () => {
    // A preview origin is a different PORT on the same host as the cockpit, and
    // cookies are not scoped by port — so an upstream `Set-Cookie` for a DorkOS
    // name would reach the cockpit. That is session fixation delivered by
    // proxied content, and it does not need the dev server to be malicious.
    const { listenPort, cookie } = await bootstrapped();

    const res = await fetchPreview(listenPort, '/sets-cookies', { headers: { cookie } });

    const relayed = res.headers['set-cookie'] ?? [];
    expect(relayed.join(' ')).not.toContain('planted');
    expect(relayed.join(' ')).not.toContain('hijack');
    // The dev app's own cookies still work — that is the whole point of relaying
    // any of them — and several stay several headers.
    expect(relayed).toContain('my_app_session=keep-me; Path=/');
    expect(relayed).toContain('theme=dark; Path=/');
    expect(relayed).toHaveLength(2);
  });

  it('answers 401 rather than hanging when token verification fails unexpectedly', async () => {
    // Both callers are fire-and-forget, so a rejection that is not a
    // WorkbenchTokenError used to become an unhandled rejection and no reply.
    const exploding = new WorkbenchTokenSigner({ secret: 'preview-listener-test-secret' });
    vi.spyOn(exploding, 'verify').mockImplementation(() => {
      throw new Error('something changed inside verify');
    });
    const manager = manage({ signer: exploding });
    const { listenPort } = await manager.acquire(upstreamPort);

    const res = await fetchPreview(listenPort, '/', {
      headers: { cookie: `${previewCookieName(listenPort)}=anything` },
    });

    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
    vi.restoreAllMocks();
  });

  it('says nothing is listening when the dev server is gone', async () => {
    const manager = manage();
    const dead = await reserveClosedPort();
    const { listenPort } = await manager.acquire(dead);
    const token = signer.mint({ kind: 'proxy', port: dead });
    await fetchPreview(listenPort, `/?__dorkos_preview=${token}`);

    const res = await fetchPreview(listenPort, '/', {
      headers: { cookie: `${previewCookieName(listenPort)}=${token}` },
    });

    expect(res.status).toBe(502);
    expect(res.body).toContain(`Nothing is listening on localhost:${dead}.`);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('pipes a WebSocket through, so live reload works', async () => {
    const { listenPort, cookie } = await bootstrapped();

    const socket = new WebSocket(`ws://127.0.0.1:${listenPort}/hmr`, {
      headers: { cookie },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('open', () => socket.send('ping'));
      socket.on('message', (data) => resolve(String(data)));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no reply')), 5_000);
    });
    socket.close();

    expect(reply).toBe('echo:ping');
  });

  it('forwards bytes that arrived with the upgrade itself', async () => {
    // A client is allowed to send its first frames in the same packet as the
    // handshake. Node hands those over separately, as `head`, and a proxy that
    // ignores them loses the first thing the client ever said.
    const { listenPort, cookie } = await bootstrapped();

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: listenPort }, () => {
        const key = 'dGhlIHNhbXBsZSBub25jZQ==';
        const request =
          `GET /hmr HTTP/1.1\r\nHost: localhost:${listenPort}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`;
        // A masked one-byte text frame "hi", written in the SAME chunk as the
        // handshake so it lands in `head` rather than arriving afterwards.
        const mask = Buffer.from([1, 2, 3, 4]);
        const payload = Buffer.from('hi');
        const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
        const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
        socket.write(Buffer.concat([Buffer.from(request, 'utf8'), frame]));
      });
      let seenBytes = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        seenBytes = Buffer.concat([seenBytes, chunk]);
        // The upstream echoes "echo:hi" back unmasked; look for it in the raw stream.
        if (seenBytes.includes('echo:hi')) {
          socket.destroy();
          resolve('echo:hi');
        }
      });
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error('no reply'));
      }, 5_000);
    });

    expect(reply).toBe('echo:hi');
  });

  it('refuses a WebSocket with no cookie', async () => {
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);

    const socket = new WebSocket(`ws://127.0.0.1:${listenPort}/hmr`);
    const outcome = await new Promise<string>((resolve) => {
      socket.on('open', () => resolve('opened'));
      socket.on('error', (err) => resolve(err.message));
    });

    expect(outcome).not.toBe('opened');
  });
});

describe('PreviewListenerManager — lifetime', () => {
  it('reuses one listener per dev server', async () => {
    const manager = manage();
    const [first, second] = await Promise.all([
      manager.acquire(upstreamPort),
      manager.acquire(upstreamPort),
    ]);
    const third = await manager.acquire(upstreamPort);

    expect(second.listenPort).toBe(first.listenPort);
    expect(third.listenPort).toBe(first.listenPort);
  });

  it('gives the port back after it has been idle, and reopens on demand', async () => {
    const manager = manage({ idleTtlMs: 50 });
    const first = await manager.acquire(upstreamPort);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(fetchPreview(first.listenPort, '/__dorkos_preview/health')).rejects.toThrow();

    const reopened = await manager.acquire(upstreamPort);
    const res = await fetchPreview(reopened.listenPort, '/__dorkos_preview/health');
    expect(res.status).toBe(204);
  });

  it('stays open while it is being used', async () => {
    const manager = manage({ idleTtlMs: 120 });
    const { listenPort } = await manager.acquire(upstreamPort);

    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const res = await fetchPreview(listenPort, '/__dorkos_preview/health');
      expect(res.status).toBe(204);
    }
  });

  it('binds inside a configured port range', async () => {
    const from = await reserveClosedPort();
    const manager = manage({ portRange: { from, to: from + 3 } });

    const { listenPort } = await manager.acquire(upstreamPort);

    expect(listenPort).toBeGreaterThanOrEqual(from);
    expect(listenPort).toBeLessThanOrEqual(from + 3);
  });

  it('reports exhaustion rather than escaping the range', async () => {
    const from = await reserveClosedPort();
    const manager = manage({ portRange: { from, to: from } });
    await manager.acquire(upstreamPort);

    await expect(manager.acquire(upstreamPort + 1)).rejects.toBeInstanceOf(
      PreviewPortExhaustedError
    );
  });

  it('closes every listener on shutdown', async () => {
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);

    await manager.close();

    await expect(fetchPreview(listenPort, '/__dorkos_preview/health')).rejects.toThrow();
  });
});

describe('PreviewListenerManager — socket lifetime', () => {
  /**
   * Run `body` while watching for an uncaught exception.
   *
   * Node hands an upgraded socket over WITHOUT its own error handling, so an
   * `'error'` on one with no listener is an uncaught exception — and this server
   * exits the process on those (`index.ts`). Installing a listener here is what
   * lets the test SEE that instead of dying with it; the assertion is that
   * nothing arrived.
   */
  async function watchingForUncaught(body: () => Promise<void>): Promise<unknown[]> {
    const caught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      caught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    try {
      await body();
      // Let a late socket error land before anyone declares victory.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    return caught;
  }

  /** Send a raw WebSocket upgrade and reset the connection without waiting. */
  function upgradeThenReset(listenPort: number, cookie?: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: listenPort }, () => {
        socket.write(
          `GET /hmr HTTP/1.1\r\nHost: localhost:${listenPort}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
            (cookie ? `Cookie: ${cookie}\r\n` : '') +
            '\r\n'
        );
        // Immediately, so the reset lands while the listener is still deciding.
        setImmediate(() => {
          socket.resetAndDestroy();
          resolve();
        });
      });
      socket.on('error', () => resolve());
    });
  }

  it('survives an unauthenticated upgrade that is reset mid-handshake', async () => {
    const manager = manage();
    const { listenPort } = await manager.acquire(upstreamPort);

    const caught = await watchingForUncaught(async () => {
      for (let i = 0; i < 15; i++) await upgradeThenReset(listenPort);
    });

    expect(caught).toEqual([]);
    // Still serving: the attack did not take the listener with it either.
    expect((await fetchPreview(listenPort, '/__dorkos_preview/health')).status).toBe(204);
  });

  it('survives an AUTHORIZED upgrade that is reset mid-handshake', async () => {
    const { listenPort, cookie } = await bootstrapped();

    const caught = await watchingForUncaught(async () => {
      for (let i = 0; i < 15; i++) await upgradeThenReset(listenPort, cookie);
    });

    expect(caught).toEqual([]);
    expect((await fetchPreview(listenPort, '/__dorkos_preview/health')).status).toBe(204);
  });

  it('survives a plain request whose client vanishes', async () => {
    const { listenPort, cookie } = await bootstrapped();

    const caught = await watchingForUncaught(async () => {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => {
          const socket = net.connect({ host: '127.0.0.1', port: listenPort }, () => {
            socket.write(
              `GET / HTTP/1.1\r\nHost: localhost:${listenPort}\r\nCookie: ${cookie}\r\n\r\n`
            );
            setImmediate(() => {
              socket.resetAndDestroy();
              resolve();
            });
          });
          socket.on('error', () => resolve());
        });
      }
    });

    expect(caught).toEqual([]);
  });

  it('survives the dev server vanishing under an open WebSocket', async () => {
    // A dev server restart is the everyday version of this.
    const doomed = http.createServer();
    const doomedWss = new WebSocketServer({ server: doomed, path: '/hmr' });
    await new Promise<void>((resolve) => doomed.listen(0, '127.0.0.1', resolve));
    const doomedPort = (doomed.address() as AddressInfo).port;

    const manager = manage();
    const { listenPort } = await manager.acquire(doomedPort);
    const token = signer.mint({ kind: 'proxy', port: doomedPort });
    const cookie = `${previewCookieName(listenPort)}=${token}`;
    const client = new WebSocket(`ws://127.0.0.1:${listenPort}/hmr`, { headers: { cookie } });
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    const caught = await watchingForUncaught(async () => {
      for (const socket of doomedWss.clients) socket.terminate();
      doomedWss.close();
      await new Promise<void>((resolve) => doomed.close(() => resolve()));
    });

    expect(caught).toEqual([]);
    client.terminate();
  });

  it('closes within a bounded time while a WebSocket is open', async () => {
    const { manager, listenPort, cookie } = await bootstrapped();
    const client = new WebSocket(`ws://127.0.0.1:${listenPort}/hmr`, { headers: { cookie } });
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    // An upgraded socket is not a connection the HTTP server will close for us,
    // so an unfixed `close()` never resolves — and this one is awaited near the
    // top of the server's shutdown, ahead of everything else it has to do.
    const closed = await Promise.race([
      manager.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);

    expect(closed).toBe('closed');
    await expect(fetchPreview(listenPort, '/__dorkos_preview/health')).rejects.toThrow();
    client.terminate();
  });

  it('keeps a listener open while a quiet WebSocket is connected to it', async () => {
    // Live reload connects once and then says nothing for hours. Reaping its
    // origin leaves a page whose HMR still works while every image, chunk and
    // reload it asks for is refused.
    const manager = manage({ idleTtlMs: 200 });
    const origin = await manager.acquire(upstreamPort);
    const token = signer.mint({ kind: 'proxy', port: upstreamPort });
    const client = new WebSocket(`ws://127.0.0.1:${origin.listenPort}/hmr`, {
      headers: { cookie: `${previewCookieName(origin.listenPort)}=${token}` },
    });
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 900));

    expect((await fetchPreview(origin.listenPort, '/__dorkos_preview/health')).status).toBe(204);
    client.terminate();
  });

  it('reaps the listener once the last WebSocket has let go', async () => {
    const manager = manage({ idleTtlMs: 200 });
    const origin = await manager.acquire(upstreamPort);
    const token = signer.mint({ kind: 'proxy', port: upstreamPort });
    const client = new WebSocket(`ws://127.0.0.1:${origin.listenPort}/hmr`, {
      headers: { cookie: `${previewCookieName(origin.listenPort)}=${token}` },
    });
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    client.close();

    await new Promise((resolve) => setTimeout(resolve, 900));

    await expect(fetchPreview(origin.listenPort, '/__dorkos_preview/health')).rejects.toThrow();
  });
});

describe('rewriteUpstreamLocation', () => {
  it.each([
    ['http://localhost:5178/next', 5178, '/next'],
    ['http://127.0.0.1:5178/next?a=1#b', 5178, '/next?a=1#b'],
    ['http://localhost:5179/next', 5178, 'http://localhost:5179/next'],
    ['https://example.com/next', 5178, 'https://example.com/next'],
    ['/already-relative', 5178, '/already-relative'],
  ])('%s (target %i) → %s', (location, port, expected) => {
    expect(rewriteUpstreamLocation(location, port)).toBe(expected);
  });
});

/** Claim a port and hand it back closed, so "nothing is listening" is a fact. */
async function reserveClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
