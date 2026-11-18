/**
 * The Wi-Fi access controller against real sockets (DOR-2930): the second
 * listener opens and closes as the switch and the login posture change.
 *
 * It binds loopback (`bindHost`) so the suite runs anywhere; which interface it
 * binds in production is one constant, and what is under test is the opening,
 * the closing and the gating.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer, Socket, type AddressInfo, type Server } from 'node:net';
import { LanAccess, type LanAccessDeps } from '../lan-access.js';
import { getLanAccessHosts, getLanAccessOrigins } from '../lan-trust.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: (error: unknown) => ({ error }),
}));

interface SocketError {
  error: NodeJS.ErrnoException;
  expectedReset: boolean;
}
interface OwnedSocket {
  socket: Socket;
  closed: Promise<void>;
  errors: SocketError[];
  expectReset: () => void;
}
const controllers: LanAccess[] = [];
const blockers: Server[] = [];
const clients: OwnedSocket[] = [];

/** Observe errors before connecting; only an explicitly armed reset is expected. */
function ownSocket(socket: Socket): OwnedSocket {
  const errors: SocketError[] = [];
  let expectedReset = false;
  socket.on('error', (error: NodeJS.ErrnoException) => errors.push({ error, expectedReset }));
  const client = {
    socket,
    closed: new Promise<void>((resolve) => socket.once('close', () => resolve())),
    errors,
    expectReset: () => {
      expectedReset = true;
    },
  };
  clients.push(client);
  return client;
}
function assertExpectedSocketErrors(errors: readonly SocketError[]): void {
  for (const { error, expectedReset } of errors) {
    if (!expectedReset || error.code !== 'ECONNRESET') throw error;
  }
}
async function openClient(port: number): Promise<OwnedSocket> {
  const client = ownSocket(new Socket());
  const connected = once(client.socket, 'connect');
  client.socket.connect(port, '127.0.0.1');
  await connected;
  return client;
}

afterEach(async () => {
  const owned = clients.splice(0);
  try {
    for (const client of owned) client.socket.destroy();
    await Promise.all(owned.map((client) => client.closed));
  } finally {
    try {
      await Promise.all(controllers.splice(0).map((controller) => controller.close()));
    } finally {
      await Promise.all(
        blockers.splice(0).map(
          (blocker) =>
            new Promise<void>((resolve, reject) => {
              blocker.close((error) => (error ? reject(error) : resolve()));
            })
        )
      );
    }
  }
  assertExpectedSocketErrors(owned.flatMap((client) => client.errors));
});

/** A port nothing holds right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** GET a path on loopback, resolving the status or the connection error code. */
function get(port: number): Promise<number | string> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    req.end();
  });
}

/** A controller over fakes, with the setting held in a variable. */
function setup(overrides: Partial<LanAccessDeps> = {}) {
  let setting = false;
  let listener: ((sections: readonly string[]) => void) | null = null;
  const deps: LanAccessDeps = {
    readSetting: () => setting,
    writeSetting: vi.fn((enabled: boolean) => {
      setting = enabled;
    }),
    canExpose: () => true,
    setByEnvironment: () => null,
    readLocalName: async () => 'studio.local',
    readAddresses: () => ['192.168.1.20'],
    onSettingsChange: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    secureCookies: true,
    bindHost: '127.0.0.1',
    isLocalPeer: () => true,
    platform: 'darwin',
    ...overrides,
  };
  const controller = new LanAccess(deps);
  controllers.push(controller);
  return {
    controller,
    deps,
    turn: (enabled: boolean) => {
      setting = enabled;
    },
    notify: (sections: readonly string[]) => listener?.(sections),
  };
}

/** A server answering 200 to everything, standing in for the front door. */
const okServer = () => createServer((_req, res) => res.end('ok'));

describe('LanAccess', () => {
  it('stays closed while the switch is off', async () => {
    const port = await freePort();
    const { controller } = setup();
    const status = await controller.attach({ port, createServer: okServer });
    expect(status).toMatchObject({ enabled: false, listening: false, port });
    expect(await get(port)).toBe('ECONNREFUSED');
    expect(getLanAccessHosts()).toEqual([]);
  });

  it('opens when switched on, trusts this computer’s names, and closes when switched off', async () => {
    const port = await freePort();
    const { controller, turn } = setup();
    await controller.attach({ port, createServer: okServer });

    turn(true);
    const open = await controller.reconcile();
    expect(open).toMatchObject({ enabled: true, listening: true, localName: 'studio.local' });
    expect(await get(port)).toBe(200);
    expect(getLanAccessHosts()).toContain('studio.local');
    expect(getLanAccessOrigins()).toContain(`http://studio.local:${port}`);

    turn(false);
    const closed = await controller.reconcile();
    expect(closed).toMatchObject({ enabled: false, listening: false });
    expect(await get(port)).toBe('ECONNREFUSED');
    expect(getLanAccessHosts()).toEqual([]);
  });

  it('follows a settings write on its own, with no call from the route', async () => {
    const port = await freePort();
    const { controller, turn, notify } = setup();
    await controller.attach({ port, createServer: okServer });

    turn(true);
    notify(['server']);
    await vi.waitFor(() => expect(controller.status().listening).toBe(true));
    expect(await get(port)).toBe(200);
  });

  it('turns the switch off, in settings too, when login is off', async () => {
    const port = await freePort();
    const { controller, deps, turn } = setup({ canExpose: () => false });
    await controller.attach({ port, createServer: okServer });

    turn(true);
    const status = await controller.reconcile();
    expect(deps.writeSetting).toHaveBeenCalledWith(false);
    expect(status).toMatchObject({ enabled: false, listening: false });
    expect(await get(port)).toBe('ECONNREFUSED');
  });

  it('closes an open listener when login is turned off later', async () => {
    const port = await freePort();
    let loginOn = true;
    const { controller, turn, notify } = setup({ canExpose: () => loginOn });
    await controller.attach({ port, createServer: okServer });
    turn(true);
    await controller.reconcile();
    expect(await get(port)).toBe(200);

    loginOn = false;
    notify(['auth']);
    await vi.waitFor(() => expect(controller.status().listening).toBe(false));
    expect(controller.status().enabled).toBe(false);
    expect(await get(port)).toBe('ECONNREFUSED');
  });

  it('stands down while DORKOS_HOST is set, and says so', async () => {
    const port = await freePort();
    const { controller, turn } = setup({ setByEnvironment: () => 'DORKOS_HOST=0.0.0.0' });
    await controller.attach({ port, createServer: okServer });
    turn(true);
    const status = await controller.reconcile();
    expect(status).toMatchObject({
      enabled: true,
      listening: false,
      setByEnvironment: 'DORKOS_HOST=0.0.0.0',
    });
    expect(await get(port)).toBe('ECONNREFUSED');
  });

  it('reports a busy port in words, and stays closed', async () => {
    const port = await freePort();
    const blocker = okServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));

    const { controller, turn } = setup();
    await controller.attach({ port, createServer: okServer });
    turn(true);
    const status = await controller.reconcile();
    expect(status.listening).toBe(false);
    expect(status.error).toContain(`port ${port}`);
    expect(getLanAccessHosts()).toEqual([]);
  });

  it('cuts a connection that stays open after the switch goes off', async () => {
    const port = await freePort();
    const { controller, turn } = setup();
    await controller.attach({ port, createServer: okServer });
    turn(true);
    await controller.reconcile();

    // A connection that never finishes a request, like a held-open stream.
    const client = await openClient(port);
    client.socket.write('GET / HTTP/1.1\r\nHost: studio.local\r\n');
    client.expectReset();
    turn(false);
    const status = await controller.reconcile();
    await client.closed;
    expect(client.socket.destroyed).toBe(true);
    expect(status.listening).toBe(false);
    expect(await get(port)).toBe('ECONNREFUSED');
  });

  it('cuts a peer that is not on this computer’s own networks before answering it', async () => {
    const port = await freePort();
    const { controller, turn } = setup({ isLocalPeer: () => false });
    await controller.attach({ port, createServer: okServer });
    turn(true);
    expect((await controller.reconcile()).listening).toBe(true);
    expect(await get(port)).toBe('ECONNRESET');
  });

  it('says plainly where the switch does not work yet, instead of blaming another program', async () => {
    const port = await freePort();
    const { controller, turn } = setup({ platform: 'linux' });
    await controller.attach({ port, createServer: okServer });
    turn(true);
    const status = await controller.reconcile();
    expect(status.listening).toBe(false);
    expect(status.error).toMatch(/works on a Mac for now/);
    expect(await get(port)).toBe('ECONNREFUSED');
  });

  it('answers the status instead of rejecting when applying the setting throws', async () => {
    const port = await freePort();
    const { controller, turn } = setup({
      writeSetting: () => {
        throw new Error('disk full');
      },
      canExpose: () => false,
    });
    await controller.attach({ port, createServer: okServer });
    turn(true);
    await expect(controller.reconcile()).resolves.toMatchObject({ listening: false });
  });
});

describe('LanAccess.dropConnections (Remote Access off, DOR-3650)', () => {
  it('cuts a kept-alive connection now and keeps listening', async () => {
    const port = await freePort();
    const { controller, turn } = setup();
    await controller.attach({ port, createServer: okServer });
    turn(true);
    await controller.reconcile();
    const client = await openClient(port);
    const response = once(client.socket, 'data');
    client.socket.write('GET / HTTP/1.1\r\nHost: studio.local\r\nConnection: keep-alive\r\n\r\n');
    await response;
    client.expectReset();
    controller.dropConnections();
    await client.closed;
    expect(client.socket.destroyed).toBe(true);
    expect(controller.status().listening).toBe(true);
    expect(await get(port)).toBe(200);
  });
});

// Real TCP delivery and synthetic policy validation are separate assertions.
describe('owned LAN test sockets', () => {
  it('observes an explicitly requested real TCP reset before close', async () => {
    const peer = createTcpServer((socket) => {
      ownSocket(socket);
      socket.once('data', () => socket.resetAndDestroy());
    });
    blockers.push(peer);
    const listening = once(peer, 'listening');
    peer.listen(0, '127.0.0.1');
    await listening;
    const client = await openClient((peer.address() as AddressInfo).port);
    client.expectReset();
    client.socket.resume();
    client.socket.write('reset');
    await client.closed;
    expect(
      client.errors.map(({ error, expectedReset }) => ({ code: error.code, expectedReset }))
    ).toEqual([{ code: 'ECONNRESET', expectedReset: true }]);
  });

  it('accepts only an armed reset and rejects unexpected socket errors', () => {
    const reset = Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' });
    const pipe = Object.assign(new Error('synthetic pipe'), { code: 'EPIPE' });
    expect(() => assertExpectedSocketErrors([{ error: reset, expectedReset: true }])).not.toThrow();
    expect(() => assertExpectedSocketErrors([{ error: reset, expectedReset: false }])).toThrow(
      reset
    );
    expect(() => assertExpectedSocketErrors([{ error: pipe, expectedReset: true }])).toThrow(pipe);
  });
});
