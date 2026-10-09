import { createServer, Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  prepare: undefined as undefined | ((context: unknown) => Promise<unknown>),
  activate: undefined as undefined | ((receiver: unknown, peer: unknown) => Promise<void>),
  listener: undefined as unknown,
  ordinary: true,
  cold: true,
  active: true,
  preparedChecks: 0,
  activeChecks: 0,
}));
vi.mock('@dorkos/browser', () => ({
  validateEngineConfiguration: (value: unknown) => value,
}));
vi.mock('../live/production-authority.js', () => ({
  createProductionBrowserAuthority: () => ({
    ports: {},
    runtime: {},
    close: async () => {},
    openEngine: async (
      _grant: unknown,
      _config: unknown,
      _command: unknown,
      network: {
        prepare: typeof fixture.prepare;
        activate: typeof fixture.activate;
      }
    ) => {
      fixture.prepare = network.prepare;
      fixture.activate = network.activate;
      return {};
    },
  }),
}));
vi.mock('../issuer.js', () => ({
  createBrokerIssuer: () => ({
    prepareRun: () => ({}),
    releaseRun: () => {},
    checkPrepared: () => {
      fixture.preparedChecks++;
      if (!fixture.cold) throw undefined;
    },
    check: () => {
      fixture.activeChecks++;
      if (!fixture.active) throw false;
    },
  }),
}));
vi.mock('../live/live-inventory.js', () => ({
  createLiveBrowserInventory: () => ({
    observe: () => ({ policyInputs: {}, inventory: { revision: 1 } }),
    retainListener: () => {},
  }),
}));
vi.mock('../../node-resolver.js', () => ({
  createProductionDestinationResolver: () => ({
    close: async () => {},
    resolve: () => {},
  }),
}));
vi.mock('../production-broker.js', () => ({
  createPreparedProductionBroker: () => ({
    start: async () => ({ server: 'http://127.0.0.1', credential: 'fixture' }),
    ownedListener: () => fixture.listener,
    isCustodyKnown: () => true,
    close: async () => true,
    activate: async () => {},
  }),
}));
import {
  createProductionLiveBrowserComposition,
  connectOriginalPreparedBrokerEndpoint,
} from '../live/production-composition.js';
const duties: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const rows = await Promise.allSettled(
    duties
      .splice(0)
      .reverse()
      .map((fn) => Promise.resolve().then(fn))
  );
  fixture.prepare = undefined;
  fixture.activate = undefined;
  for (const row of rows) if (row.status === 'rejected') throw row.reason;
});
async function endpoint() {
  fixture.ordinary = true;
  fixture.cold = true;
  fixture.active = true;
  fixture.preparedChecks = 0;
  fixture.activeChecks = 0;
  let admitted!: () => void;
  const accepted = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    admitted();
  });
  duties.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ORIGINAL_FIXTURE_ADDRESS');
  fixture.listener = {
    identity: server,
    address: '127.0.0.1',
    port: address.port,
    isCustodyKnown: () => server.listening,
  };
  // Only authority prerequisites are controlled here. Actual original Socket/listener and
  // genuine production prepare/token branch execute; this is not production qualification.
  const graph = createProductionLiveBrowserComposition({
    engineConfiguration: {
      network: { kind: 'owned', policyRevision: 1 },
      runtime: { identity: { mode: 'native' } },
      nativeJournal: {},
    },
    inventory: {},
  } as never);
  duties.push(() => graph.close());
  await graph.open({} as never, {}, {} as never);
  const receiver = {
    browserId: 'A'.repeat(22),
    browserGeneration: 1,
    isOrdinary: () => fixture.ordinary,
  };
  const peer = (await fixture.prepare!({
    binding: { browserId: receiver.browserId, browserGeneration: 1 },
    receiver,
    runtimeIdentity: 'fixture',
    authorizationEpoch: 1,
    policyRevision: 1,
  })) as { originalSerialProxyEndpoint(): object; close(): Promise<void> };
  return { graph, peer, receiver, server, sockets, accepted };
}
it('forged endpoint cannot enter any original Socket connect', () => {
  const spy = vi.spyOn(Socket.prototype, 'connect');
  try {
    for (const token of [{}, { kind: 'original-prepared-broker-endpoint' }, () => {}])
      expect(() => connectOriginalPreparedBrokerEndpoint(token)).toThrow();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it('cold prepared token connects exact genuine listener before ready, then original peer close joins it', async () => {
  const { peer, sockets, accepted } = await endpoint();
  const connection = connectOriginalPreparedBrokerEndpoint(peer.originalSerialProxyEndpoint());
  duties.push(() => connection.close());
  await connection.connected;
  await accepted;
  expect(fixture.preparedChecks).toBeGreaterThan(0);
  expect(fixture.activeChecks).toBe(0);
  expect(sockets.size).toBe(1);
  await peer.close();
  await connection.closed;
  expect(connection.socket.destroyed).toBe(true);
  expect(() => connectOriginalPreparedBrokerEndpoint(peer.originalSerialProxyEndpoint())).toThrow();
});
it('retired original receiver refuses token entry and preserves undefined cold check', async () => {
  const { peer } = await endpoint();
  const token = peer.originalSerialProxyEndpoint();
  fixture.cold = false;
  const connection = connectOriginalPreparedBrokerEndpoint(token);
  duties.push(() => connection.close());
  let caught = false;
  try {
    await connection.connected;
  } catch (value) {
    caught = true;
    expect(value).toBeUndefined();
  }
  expect(caught).toBe(true);
  await connection.closed;
  fixture.cold = true;
  fixture.ordinary = false;
  expect(() => peer.originalSerialProxyEndpoint()).toThrow();
});
it('active token uses exact active issuer check and preserves false original cause', async () => {
  const { peer, receiver } = await endpoint();
  const token = peer.originalSerialProxyEndpoint();
  await fixture.activate!(receiver, peer);
  fixture.active = false;
  const connection = connectOriginalPreparedBrokerEndpoint(token);
  duties.push(() => connection.close());
  let caught = false;
  try {
    await connection.connected;
  } catch (value) {
    caught = true;
    expect(value).toBe(false);
  }
  expect(caught).toBe(true);
  await connection.closed;
  expect(fixture.activeChecks).toBeGreaterThan(0);
});

it('original broker read EOF preserves separate writable duty until explicit guest end', async () => {
  const { peer, sockets, accepted } = await endpoint();
  const connection = connectOriginalPreparedBrokerEndpoint(peer.originalSerialProxyEndpoint());
  duties.push(() => connection.close());
  await connection.connected;
  await accepted;
  const remote = [...sockets][0]!;
  const payload = Buffer.from('original bytes after broker read EOF');
  const originals: Promise<unknown>[] = [];
  duties.push(async () => {
    for (const row of await Promise.allSettled(originals))
      if (row.status === 'rejected') throw row.reason;
  });
  let received!: () => void;
  const observed = new Promise<void>((resolve) => {
    received = resolve;
  });
  const chunks: Buffer[] = [];
  remote.on('data', (bytes: Buffer) => {
    chunks.push(Buffer.from(bytes));
    if (Buffer.concat(chunks).length >= payload.length) received();
  });
  const readEnd = new Promise<void>((resolve) => connection.socket.once('end', resolve));
  connection.socket.resume();
  const remoteEnd = new Promise<void>((resolve, reject) =>
    remote.end((error?: Error | null) => (error ? reject(error) : resolve()))
  );
  originals.push(remoteEnd);
  await remoteEnd;
  await readEnd;
  // Let Node's automatic end turn run: the old default Socket closes here.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(connection.socket.writableEnded).toBe(false);
  expect(connection.socket.destroyed).toBe(false);
  connection.check();
  const write = new Promise<void>((resolve, reject) =>
    connection.socket.write(payload, (error) => (error ? reject(error) : resolve()))
  );
  originals.push(write);
  await write;
  await observed;
  expect(Buffer.concat(chunks)).toEqual(payload);
  const end = new Promise<void>((resolve, reject) =>
    connection.socket.end((error?: Error | null) => (error ? reject(error) : resolve()))
  );
  originals.push(end);
  await end;
  await connection.closed;
}, 5000);
