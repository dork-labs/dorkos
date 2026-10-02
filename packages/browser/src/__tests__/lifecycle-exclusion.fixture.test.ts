import './native-fixture-preflight.js';
import { it, expect } from 'vitest';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createBrowserEngine } from '../index.js';
import { hostIdentity } from '../runtime/host-identity.js';
import { deadline } from '../lifecycle/deadline.js';
import { fixture, configuration, processes, requestId, profileId } from './lifecycle-fixture.js';

function worker() {
  const require = createRequire(import.meta.url);
  const child = fork(fileURLToPath(new URL('./lifecycle-worker.mjs', import.meta.url)), [], {
    execArgv: ['--import', require.resolve('tsx')],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let identity: NonNullable<ReturnType<typeof hostIdentity>> | undefined;
  const queued: { kind: string; code?: string; results?: { cleanup: string }[] }[] = [];
  const waiters: ((value: (typeof queued)[number]) => void)[] = [];
  const errors: string[] = [];
  child.stderr?.on('data', (bytes) => errors.push(bytes.toString()));
  child.on('message', (value) => {
    const next = waiters.shift();
    if (next) next(value as (typeof queued)[number]);
    else queued.push(value as (typeof queued)[number]);
  });
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true;
      resolve();
    })
  );
  const next = () =>
    deadline(
      queued.length
        ? Promise.resolve(queued.shift()!)
        : new Promise<(typeof queued)[number]>((resolve, reject) => {
            if (exited) {
              reject(Error('CHILD_EXITED_BEFORE_REPLY'));
              return;
            }
            const onExit = () => reject(Error('CHILD_EXITED_BEFORE_REPLY'));
            const onError = () => reject(Error('CHILD_START_FAILED'));
            child.once('exit', onExit);
            child.once('error', onError);
            waiters.push((value) => {
              child.off('exit', onExit);
              child.off('error', onError);
              resolve(value);
            });
          }),
      8000,
      'CHILD_REPLY_TIMEOUT'
    );
  return {
    async open(dataDir: string, origin: string) {
      expect(await next()).toMatchObject({ kind: 'ready' });
      identity = hostIdentity(child.pid!) ?? undefined;
      if (!identity) throw Error('CHILD_IDENTITY_UNAVAILABLE');
      child.send({ kind: 'open', dataDir, origin });
      return next();
    },
    async stop() {
      try {
        if (!exited) {
          child.send({ kind: 'stop' });
          const result = await next();
          expect(result.kind).toBe('stopped');
          expect(result.results?.every((row) => row.cleanup === 'observed')).toBe(true);
        }
        await deadline(exit, 8000, 'CHILD_EXIT_TIMEOUT');
      } finally {
        if (!exited) {
          const owner = identity ?? hostIdentity(child.pid!);
          expect(owner).not.toBe(null);
          const inventory = await processes.descendants(owner!, new AbortController().signal);
          expect(inventory.status).toBe('complete');
          for (const owned of [...inventory.identities].reverse()) {
            const current = hostIdentity(owned.pid);
            if (current?.birth === owned.birth) process.kill(owned.pid, 'SIGTERM');
          }
          await deadline(exit, 2000, 'CHILD_CLEANUP_TIMEOUT');
        }
        expect(hostIdentity(child.pid!)).toBe(null);
        expect(errors.join('')).not.toMatch(/uncaught|unhandled/i);
      }
    },
  };
}

it('excludes a second independent manager process without changing the retained fixture seed', async () => {
  const owned = await fixture();
  const dataDir = join(owned.root, 'data');
  const engine = createBrowserEngine(await configuration(dataDir, owned.origin, true));
  const children: ReturnType<typeof worker>[] = [];
  try {
    owned.configure({ seed: true });
    const seed = await engine.open({ kind: 'open', requestId, mode: 'persistent', profileId });
    await expect.poll(() => owned.reports.length).toBe(1);
    expect(
      await engine.close({
        kind: 'close',
        requestId,
        browserId: seed.browserId,
        browserGeneration: 0,
      })
    ).toMatchObject({ cleanup: 'observed' });
    owned.configure({ seed: false });
    const holder = worker();
    children.push(holder); // Cleanup registered before the first IPC wait.
    expect(await holder.open(dataDir, owned.origin)).toMatchObject({ kind: 'opened' });
    await expect.poll(() => owned.reports.length).toBe(2);
    const contender = worker();
    children.push(contender);
    expect(await contender.open(dataDir, owned.origin)).toEqual({
      kind: 'refused',
      code: 'PROFILE_IN_USE',
    });
    expect(owned.reports).toHaveLength(2);
    await children.pop()!.stop();
    await children.pop()!.stop();
    const reopened = await engine.open({ kind: 'open', requestId, mode: 'persistent', profileId });
    await expect.poll(() => owned.reports.length).toBe(3);
    expect(owned.reports[2]!.seed).toBe('retained-A');
    expect(owned.reports[2]!.cookie).toContain('seed=retained-A');
    expect(reopened.browserId).not.toBe(seed.browserId);
  } finally {
    const failures: unknown[] = [];
    for (const child of children.reverse())
      try {
        await child.stop();
      } catch (error) {
        failures.push(error);
      }
    const stopped = await engine.shutdown();
    await owned.close(
      stopped.every((result) => result.cleanup === 'observed') && failures.length === 0
    );
    expect(failures).toEqual([]);
    expect(stopped.every((result) => result.cleanup === 'observed')).toBe(true);
  }
}, 30_000);
