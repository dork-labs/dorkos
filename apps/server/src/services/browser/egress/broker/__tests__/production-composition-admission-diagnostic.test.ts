import { expect, it, onTestFinished, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
const originals = vi.hoisted(() => ({
  info: vi.fn(),
  native: vi.fn(() => true),
  authorize: vi.fn(),
  check: vi.fn(),
  known: vi.fn(() => true),
  close: vi.fn(async () => {}),
  open: vi.fn(),
  start: vi.fn(),
  listener: vi.fn(),
  brokerClose: vi.fn(),
}));
vi.mock('../../../../../lib/logger.js', () => ({ logger: { info: originals.info } }));
vi.mock('@dorkos/browser', () => ({
  validateEngineConfiguration: () => ({
    network: { kind: 'owned', policyRevision: 1 },
    runtime: { identity: { mode: 'native' } },
    nativeJournal: {},
  }),
}));
vi.mock('../live/production-authority.js', () => ({
  createProductionBrowserAuthority: () => ({
    ports: {},
    runtime: { isNativeCurrent: originals.native },
    authorizeOriginal: originals.authorize,
    openEngine: originals.open,
    close: originals.close,
  }),
}));
vi.mock('../issuer.js', () => ({
  createBrokerIssuer: () => ({
    prepareRun: () => ({}),
    releaseRun: () => {},
    check: originals.check,
  }),
}));
vi.mock('../live/live-inventory.js', () => ({
  createLiveBrowserInventory: () => ({
    observe: () => ({ inventory: { revision: 1 }, policyInputs: {} }),
    retainListener: () => {},
  }),
}));
vi.mock('../../node-resolver.js', () => ({
  createProductionDestinationResolver: () => ({
    resolve: () => {},
    close: async () => {},
  }),
}));
vi.mock('../production-broker.js', () => ({
  createPreparedProductionBroker: () => ({
    start: originals.start,
    ownedListener: originals.listener,
    isCustodyKnown: originals.known,
    close: originals.brokerClose,
  }),
}));
import { createProductionLiveBrowserComposition } from '../live/production-composition.js';

async function originalComposition() {
  // Only the admission prerequisites are controlled. The listener and every
  // delivered connection retain their genuine Node ownership and close.
  const server = createServer();
  const sockets = new Set<Socket>();
  let closing: Promise<boolean> | undefined;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('error', () => {});
  const closeListener = () =>
    (closing ??= new Promise<boolean>((resolve, reject) => {
      const originalCloses = [...sockets].map(
        (socket) =>
          new Promise<void>((done) => {
            socket.once('close', done);
            socket.destroy();
          })
      );
      if (!server.listening) {
        void Promise.all(originalCloses).then(() => resolve(true), reject);
        return;
      }
      server.close((error) => {
        void Promise.all(originalCloses).then(
          () => (error ? reject(error) : resolve(true)),
          reject
        );
      });
    }));
  onTestFinished(async () => {
    await closeListener();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Original fixture listener refused');
  const listener = { identity: server, port: address.port, isCustodyKnown: () => server.listening };
  originals.start
    .mockReset()
    .mockResolvedValue({ server: `http://127.0.0.1:${address.port}`, credential: 'private-test' });
  originals.listener.mockReset().mockReturnValue(listener);
  originals.brokerClose.mockReset().mockImplementation(closeListener);
  originals.info.mockReset();
  originals.native.mockReset().mockReturnValue(true);
  originals.authorize.mockReset();
  originals.check.mockReset();
  originals.known.mockReset().mockReturnValue(true);
  originals.close.mockReset().mockResolvedValue(undefined);
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  const receiver = {
    browserId: binding.browserId,
    browserGeneration: binding.browserGeneration,
    isOrdinary: () => true,
  };
  originals.open.mockReset().mockImplementation(async (...args: unknown[]) => {
    const network = args[3] as { prepare(context: unknown): Promise<unknown> };
    await network.prepare({
      binding,
      receiver,
      runtimeIdentity: 'private-runtime',
      authorizationEpoch: 1,
      policyRevision: 1,
    });
    return { engine: {}, opened: {}, binding };
  });
  const original = createProductionLiveBrowserComposition(
    {} as Parameters<typeof createProductionLiveBrowserComposition>[0]
  );
  onTestFinished(async () => {
    await original.close();
  });
  const grant = {} as Parameters<typeof original.isCurrent>[0];
  return {
    original,
    grant,
    open: () => original.open(grant, {}, {} as Parameters<typeof original.open>[2]),
  };
}
it('records acquired and native short circuits without extra authorization or native calls', async () => {
  const x = await originalComposition();
  expect(x.original.isCurrent(x.grant)).toBe(false);
  expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({ stage: 'network.acquired', ordinal: 1 });
  expect(originals.native).not.toHaveBeenCalled();
  await x.open();
  originals.native.mockReturnValue(false);
  expect(x.original.isCurrent(x.grant)).toBe(false);
  expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({
    stage: 'network.native-before',
    ordinal: 2,
  });
  expect(originals.authorize).not.toHaveBeenCalled();
  expect(originals.native).toHaveBeenCalledOnce();
});
it.each(['authorize', 'peer', 'issuer'] as const)(
  'enters original close before logging %s refusal',
  async (decision) => {
    const x = await originalComposition();
    await x.open();
    if (decision === 'authorize')
      originals.authorize.mockImplementation(() => {
        throw undefined;
      });
    if (decision === 'peer') originals.known.mockReturnValue(false);
    if (decision === 'issuer')
      originals.check.mockImplementation(() => {
        throw false;
      });
    let closeCallsAtDiagnostic = -1;
    originals.info.mockImplementation(() => {
      closeCallsAtDiagnostic = originals.close.mock.calls.length;
      throw new Error('DIAGNOSTIC_ONLY');
    });
    expect(x.original.isCurrent(x.grant)).toBe(false);
    expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({
      stage: `network.${decision}`,
      ordinal: 1,
    });
    expect(originals.native).toHaveBeenCalledOnce();
    expect(closeCallsAtDiagnostic).toBe(1);
    await x.original.close();
  }
);
it.each([false, undefined])(
  'preserves pre-try native fault %s and does not invent network close',
  async (cause) => {
    const x = await originalComposition();
    await x.open();
    originals.native.mockImplementation(() => {
      throw cause;
    });
    originals.info.mockImplementation(() => {
      throw new Error('DIAGNOSTIC_ONLY');
    });
    let first: { value: unknown } | undefined;
    try {
      x.original.isCurrent(x.grant);
    } catch (value) {
      first = { value };
    }
    expect(first).toEqual({ value: cause });
    expect(originals.close).not.toHaveBeenCalled();
    expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({
      stage: 'network.native-before',
      ordinal: 1,
    });
  }
);
it('keeps successful original query order and labels a final native refusal', async () => {
  const x = await originalComposition();
  await x.open();
  expect(x.original.isCurrent(x.grant)).toBe(true);
  expect(originals.info).not.toHaveBeenCalled();
  expect(originals.native).toHaveBeenCalledTimes(2);
  expect(originals.authorize).toHaveBeenCalledOnce();
  expect(originals.check).toHaveBeenCalledOnce();
  originals.native.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false);
  expect(x.original.isCurrent(x.grant)).toBe(false);
  expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({
    stage: 'network.native-after',
    ordinal: 1,
  });
});
