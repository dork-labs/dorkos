import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('./fixture-page.html', import.meta.url));
const serviceWorker = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));`;
const validMarker = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

/** Start a loopback-only fictitious authenticated site; it never accesses external accounts. */
export async function startFixture({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError('Invalid fixture port');
  const cacheRequests = new Map();
  const blocked = new Map();
  const blockedObservers = new Set();
  const sockets = new Set();
  let origin;
  const server = createServer((request, response) => {
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url, origin);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/' && request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(page);
    } else if (url.pathname === '/login' && request.method === 'POST') {
      const mode = url.searchParams.get('mode') ?? 'persistent';
      const cookies = {
        persistent:
          'fixture_login=fictitious-user; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict',
        short: 'fixture_login=fictitious-user; Max-Age=1; Path=/; HttpOnly; SameSite=Strict',
        expired: 'fixture_login=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
        session: 'fixture_session=fictitious-session; Path=/; HttpOnly; SameSite=Strict',
      };
      if (!Object.hasOwn(cookies, mode)) {
        response.writeHead(400).end();
        return;
      }
      response.setHeader('Set-Cookie', cookies[mode]);
      response.end('signed-in');
    } else if (url.pathname === '/logout' && request.method === 'POST') {
      response.setHeader('Set-Cookie', [
        'fixture_login=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
        'fixture_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
      ]);
      response.end('signed-out');
    } else if (url.pathname === '/whoami' || url.pathname === '/protected') {
      const signedIn = (request.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim() === 'fixture_login=fictitious-user');
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/protected' && !signedIn) response.statusCode = 401;
      const session = (request.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim() === 'fixture_session=fictitious-session');
      response.end(
        JSON.stringify({
          identity: signedIn ? 'fictitious-user' : null,
          sessionIdentity: session ? 'fictitious-session' : null,
        })
      );
    } else if (url.pathname === '/blocked') {
      const marker = url.searchParams.get('marker');
      if (!validMarker.test(marker ?? '') || blocked.size >= 32 || blocked.has(marker)) {
        response.writeHead(400).end();
        return;
      }
      blocked.set(marker, response);
      for (const observer of blockedObservers) observer(marker);
      response.on('close', () => {
        if (blocked.get(marker) === response) blocked.delete(marker);
      });
    } else if (url.pathname === '/service-worker.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(serviceWorker);
    } else if (url.pathname === '/cache-resource') {
      const marker = url.searchParams.get('marker');
      if (!validMarker.test(marker ?? '')) {
        response.writeHead(400).end();
        return;
      }
      cacheRequests.set(marker, (cacheRequests.get(marker) ?? 0) + 1);
      response.setHeader('Cache-Control', 'private, max-age=86400');
      response.setHeader('Content-Type', 'text/plain');
      response.end(marker);
    } else if (url.pathname === '/health') {
      response.end('fixture-ready');
    } else {
      response.writeHead(404).end('fixture-missing');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    url: origin,
    stats: () => Object.fromEntries(cacheRequests),
    blocked: () => [...blocked.keys()],
    onBlocked(observer) {
      if (typeof observer !== 'function' || blockedObservers.size >= 32)
        throw new TypeError('Invalid or excessive blocked observers');
      blockedObservers.add(observer);
      return () => blockedObservers.delete(observer);
    },
    release(marker) {
      const response = blocked.get(marker);
      if (!response) return false;
      blocked.delete(marker);
      response.end('fixture-released');
      return true;
    },
    async close() {
      if (closed) return;
      closed = true;
      blockedObservers.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
