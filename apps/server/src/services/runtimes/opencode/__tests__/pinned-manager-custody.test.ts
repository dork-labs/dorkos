import { expect, it, vi } from 'vitest';
import type { RunSpawnPort } from '@dorkos/test-utils/run-custody';
import type { SidecarSpawnPort } from '../sidecar-custody.js';
import {
  createPinnedManagerCustody,
  type PinnedManagerCustodyDependencies,
} from './pinned-manager-custody.js';
import type { guardPinnedOpenCodePort } from './pinned-opencode-owned.js';

type OwnedPinnedChild = Awaited<ReturnType<ReturnType<typeof guardPinnedOpenCodePort>['start']>>;

const mocks = {
  acquire: vi.fn<PinnedManagerCustodyDependencies['acquire']>(),
  start: vi.fn<ReturnType<typeof guardPinnedOpenCodePort>['start']>(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup() {
  mocks.acquire.mockReset();
  mocks.start.mockReset();
  const backendPort: RunSpawnPort = {
    start: async () => {
      throw new Error('Unexpected unguarded fixture start');
    },
  };
  const fixture = createPinnedManagerCustody(
    { kind: 'unavailable', reason: 'windows-acl-unverified' },
    new AbortController().signal,
    { acquire: mocks.acquire, guard: () => ({ start: mocks.start }) }
  );
  const request: Parameters<SidecarSpawnPort['start']>[0] = {
    executable: '/fixture/unused',
    argv: ['serve'],
    env: {},
    cwd: '/fixture',
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    deadline: Date.now() + 5_000,
  };
  const owner = new AbortController();
  const start = () => fixture.port.start(request, owner.signal);
  const identity = { kind: 'spawned', pid: 42, executable: request.executable } as const;
  const read = vi.fn(async () => ({ kind: 'eof' }) as const);
  const stop = vi.fn(async () => ({ kind: 'cleaned-owned' }) as const);
  const child: OwnedPinnedChild = {
    pid: 42,
    executable: request.executable,
    spawn: Promise.resolve(identity),
    exit: Promise.resolve({ kind: 'exited', code: 0, signal: null }),
    close: Promise.resolve({ kind: 'native-closed', integrity: 'verified' }),
    stdout: { read },
    stderr: { read },
    stopAndJoin: stop,
    verified: Promise.resolve(),
  };
  let startup: AbortSignal | undefined;
  mocks.start.mockImplementation(async (_request: unknown, signal: AbortSignal) => {
    startup = signal;
    return child;
  });
  return { fixture, owner, start, stop, request, backendPort, startup: () => startup };
}

it('retains through pending acquisition and a worker close that outlives manager wait', async () => {
  const { fixture, owner, start, stop, request, backendPort, startup } = setup();
  const closed = deferred<void>();
  const enteredClose = deferred<void>();
  const workerClose = vi.fn(() => {
    enteredClose.resolve();
    return closed.promise;
  });
  const acquired = deferred<Awaited<ReturnType<PinnedManagerCustodyDependencies['acquire']>>>();
  mocks.acquire.mockReturnValue(acquired.promise);
  const pending = start();
  expect(fixture.report().retain).toBe(true);
  await expect(start()).rejects.toThrow('Previous pinned serve');
  acquired.resolve({ channel: { port: backendPort }, close: workerClose });
  const child = await pending;
  owner.abort();
  expect(startup()?.aborted).toBe(false);
  const first = child.stopAndJoin('manager-timeout', Date.now() + 5_000);
  const retry = child.stopAndJoin('manager-timeout', Date.now() + 5_000);
  expect(first).toBe(retry);
  await enteredClose.promise;
  expect(fixture.report().retain).toBe(true);
  await expect(start()).rejects.toThrow('Previous pinned serve');
  expect(stop).toHaveBeenCalledTimes(1);
  closed.resolve();
  await expect(first).resolves.toEqual({ kind: 'cleaned-owned' });
  expect(fixture.report()).toEqual({ retain: false, failures: [] });
  expect(workerClose).toHaveBeenCalledTimes(1);
  const nextOwner = new AbortController();
  const next = await fixture.port.start(request, nextOwner.signal);
  nextOwner.abort();
  await expect(next.stopAndJoin('repeat', Date.now() + 5_000)).resolves.toEqual({
    kind: 'cleaned-owned',
  });
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
});

it('continues retaining on rejected worker close and keeps the subsidiary failure', async () => {
  const { fixture, owner, start, backendPort } = setup();
  const fault = new Error('Synthetic worker close failed');
  mocks.acquire.mockResolvedValue({
    channel: { port: backendPort },
    close: async () => {
      throw fault;
    },
  });
  const child = await start();
  owner.abort();
  await expect(child.stopAndJoin('cleanup', Date.now() + 5_000)).resolves.toMatchObject({
    kind: 'cleanup-uncertain',
  });
  expect(fixture.report()).toEqual({ retain: true, failures: [fault] });
  await expect(start()).rejects.toThrow('Previous pinned serve');
});
