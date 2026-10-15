/**
 * The Wi-Fi access controller against real sockets (DOR-2930): the second
 * listener opens and closes as the switch and the login posture change.
 *
 * It binds loopback (`bindHost`) so the suite runs anywhere; which interface it
 * binds in production is one constant, and what is under test is the opening,
 * the closing and the gating.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { LanAccess, type LanAccessDeps } from '../lan-access.js';
import { getLanAccessHosts, getLanAccessOrigins } from '../lan-trust.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: (error: unknown) => ({ error }),
}));

const controllers: LanAccess[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  for (const blocker of blockers.splice(0)) await new Promise((r) => blocker.close(r));
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
    envHost: null,
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
    const { controller, turn } = setup({ envHost: '0.0.0.0' });
    await controller.attach({ port, createServer: okServer });
    turn(true);
    const status = await controller.reconcile();
    expect(status).toMatchObject({ enabled: true, listening: false, envHost: '0.0.0.0' });
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
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('GET / HTTP/1.1\r\nHost: studio.local\r\n');
    const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    turn(false);
    await controller.reconcile();
    await ended;
    expect(socket.destroyed).toBe(true);
  });
});
