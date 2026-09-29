import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { attachUpgradeRouter, type UpgradeDecision, type UpgradeRoute } from '../upgrade-router.js';
import { authorizeStreamUpgrade } from '../stream-upgrade-auth.js';

vi.mock('../../tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => ({ enabled: false })) },
}));
vi.mock('../stream-upgrade-auth.js', () => ({ authorizeStreamUpgrade: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let server: Server;
let port: number;
let sockets: WebSocket[];
let admission: MainRequestAdmission;
const credential = vi.mocked(authorizeStreamUpgrade);

async function listen(route: UpgradeRoute) {
  server = createServer((_req, res) => res.end('running'));
  attachUpgradeRouter(server, [route], admission);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
}

/** Report an actual refused HTTP handshake, or an accepted socket's first frame/close. */
function attempt(url = '/admission', headers: Record<string, string> = {}) {
  const opened = vi.fn();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`, { headers });
  sockets.push(ws);
  const outcome = new Promise<{ status?: number; message?: string; closeCode?: number }>(
    (resolve) => {
      ws.on('open', opened);
      ws.on('message', (raw) => resolve({ message: raw.toString() }));
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ status: res.statusCode });
        ws.terminate();
      });
      ws.on('error', () => {}); // A refused handshake/explicit terminate is followed by close.
      ws.on('close', (code) => resolve({ closeCode: code }));
    }
  );
  return { ws, opened, outcome };
}

function routeFor(posture: UpgradeRoute['credential']) {
  const open = vi.fn((ws: WebSocket) => {
    sockets.push(ws);
    ws.on('message', (data) => ws.send(data));
    ws.send('accepted');
  });
  const authorize = vi.fn<UpgradeRoute['authorize']>(() => ({ ok: true, open }));
  return {
    route: { name: 'admission', pattern: /^\/admission$/, credential: posture, authorize },
    authorize,
    open,
  };
}

beforeEach(() => {
  sockets = [];
  admission = new MainRequestAdmission();
  credential.mockReset().mockResolvedValue({ ok: true, locals: {} });
});
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('main WebSocket admission over real loopback handshakes', () => {
  // A4 positive controls: both postures really acquire a socket, and existing sockets survive closure.
  it.each(['required', 'bearer-of-id'] as const)(
    'accepts %s while open and preserves the accepted socket after close',
    async (posture) => {
      const { route, authorize, open } = routeFor(posture);
      await listen(route);
      const client = attempt();
      expect(await client.outcome).toEqual({ message: 'accepted' });
      expect(client.opened).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(credential).toHaveBeenCalledTimes(posture === 'required' ? 1 : 0);
      admission.close();
      const echo = once(client.ws, 'message');
      client.ws.send('still active');
      expect(String((await echo)[0])).toBe('still active');
      const refused = attempt();
      expect(await refused.outcome).toEqual({ status: 503 });
      expect(refused.opened).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(credential).toHaveBeenCalledTimes(posture === 'required' ? 1 : 0);
    }
  );

  // A4 entry: terminal refusal precedes even path lookup and hostile-origin/credential decisions.
  it.each(['/admission', '/unknown'])(
    'refuses %s after close without route lookup, authorization or handshake',
    async (url) => {
      const { route, authorize, open } = routeFor('required');
      const lookup = vi.spyOn(route.pattern, 'exec');
      const handshake = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade');
      await listen(route);
      admission.close();
      const client = attempt(url, { Origin: 'https://untrusted.example' });
      expect(await client.outcome).toEqual({ status: 503 });
      expect(lookup).not.toHaveBeenCalled();
      expect(credential).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(handshake).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(client.opened).not.toHaveBeenCalled();
    }
  );

  // A4 final: a pending credential attempt has not been admitted, even if it later allows/refuses/throws.
  it.each(['allow', 'deny', 'throw'] as const)(
    'refuses credential authorization settling with %s after close',
    async (result) => {
      const { route, authorize, open } = routeFor('required');
      const waiting = deferred<void>();
      const auth = deferred<Awaited<ReturnType<typeof authorizeStreamUpgrade>>>();
      credential.mockImplementationOnce(() => {
        waiting.resolve();
        return auth.promise;
      });
      const handshake = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade');
      await listen(route);
      const client = attempt();
      await waiting.promise;
      expect(credential).toHaveBeenCalledTimes(1);
      admission.close();
      if (result === 'throw') auth.reject(new Error('credential failure'));
      else
        auth.resolve(
          result === 'allow'
            ? { ok: true, locals: {} }
            : { ok: false, status: 401, message: 'Unauthorized' }
        );
      expect(await client.outcome).toEqual({ status: 503 });
      expect(authorize).not.toHaveBeenCalled();
      expect(handshake).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(client.opened).not.toHaveBeenCalled();
    }
  );

  // A4 final: cover normal accepts plus both existing refusal transports, under both credential postures.
  it.each(
    (['required', 'bearer-of-id'] as const).flatMap((posture) =>
      (['allow', 'handshake', 'close-frame', 'throw'] as const).map((result) => ({
        posture,
        result,
      }))
    )
  )(
    'refuses $posture route authorization settling with $result after close',
    async ({ posture, result }) => {
      const { route, authorize, open } = routeFor(posture);
      const waiting = deferred<void>();
      const decision = deferred<UpgradeDecision>();
      authorize.mockImplementationOnce(() => {
        waiting.resolve();
        return decision.promise;
      });
      const handshake = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade');
      await listen(route);
      const client = attempt();
      await waiting.promise;
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(credential).toHaveBeenCalledTimes(posture === 'required' ? 1 : 0);
      admission.close();
      if (result === 'throw') decision.reject(new Error('route failure'));
      else
        decision.resolve(
          result === 'allow'
            ? { ok: true, open }
            : { ok: false, status: 403, message: 'Forbidden', deliver: result }
        );
      expect(await client.outcome).toEqual({ status: 503 });
      expect(handshake).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(client.opened).not.toHaveBeenCalled();
    }
  );
});
