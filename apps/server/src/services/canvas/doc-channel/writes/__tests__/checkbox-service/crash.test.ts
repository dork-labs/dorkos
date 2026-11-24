import { readFile, stat, readdir } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { fixture as makeFixture } from '../checkbox-fixture.js';
import type { CheckboxServiceOptions } from '../../checkbox-service.js';
import { buildCrashWorkerBundle, type CrashWorkerBundle } from '../checkbox-crash-worker-bundle.js';

// The crash worker, compiled once for this file: each crash test still forks a
// fresh child of its own, on plain node rather than `--import tsx` (see
// `checkbox-crash-worker-bundle.ts`). `execArgv: []` keeps the fork from
// inheriting this Vitest worker's flags, as the explicit tsx list did.
let crashWorker: CrashWorkerBundle;
beforeAll(async () => {
  crashWorker = await buildCrashWorkerBundle();
}, 60_000);
afterAll(async () => {
  await crashWorker?.dispose();
});

const crashTests: { drain(): Promise<void> }[] = [];
function crashTestOwnership() {
  let active = true;
  let child: ReturnType<typeof fork> | undefined;
  let closed: Promise<void> | undefined;
  let exited: Promise<void> | undefined;
  let pipes: Promise<void>[] = [];
  let pipeFailed = false,
    firstPipeCause: unknown;
  const outputLimit = 65536;
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let task: Promise<void> | undefined;
  let cancelCheckpoint: (() => void) | undefined;
  let ready: Promise<void> | undefined;
  const assertActive = () => {
    if (!active) throw new Error('Crash test ended.');
  };
  const owner = {
    assertActive,
    run(work: () => Promise<void>) {
      task = work();
      void task.catch(() => {});
      return task;
    },
    capture(value: ReturnType<typeof fork>, preload = false) {
      assertActive();
      child = value;
      // Attach lifecycle custody before the first checkpoint wait or any kill.
      exited = new Promise<void>((resolve) => {
        value.once('exit', () => resolve());
        // A failed spawn can close without emitting exit; close/pipe waits still own cleanup.
        value.once('error', () => resolve());
      });
      closed = new Promise<void>((resolve) => value.once('close', () => resolve()));
      pipes = (['stdout', 'stderr'] as const).map((name) => {
        const stream = value[name];
        if (!stream) throw new Error(`Missing original crash worker ${name} pipe.`);
        const drained = new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk: Buffer | string) => {
            // Keep reading after the bounded diagnostic buffer fills.
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = outputLimit - output[name].length;
            if (remaining > 0)
              output[name] = Buffer.concat([output[name], bytes.subarray(0, remaining)]);
          });
          stream.once('end', resolve);
          stream.once('close', resolve);
          stream.once('error', (cause: unknown) => {
            if (!pipeFailed) {
              pipeFailed = true;
              firstPipeCause = cause;
            }
            reject(cause);
          });
        });
        void drained.catch(() => {});
        return drained;
      });
      let startupReceived = !preload;
      let resolveReady!: () => void, rejectReady!: (cause: unknown) => void;
      ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void ready.catch(() => {});
      if (!preload) resolveReady();
      const checkpoint = new Promise<{
        dir: string;
        documentId: string;
        grantId: string;
        eventId: string;
      }>((resolve, reject) => {
        const onMessage = (data: unknown) => {
          if (!active) return;
          if (!startupReceived) {
            if (
              !data ||
              typeof data !== 'object' ||
              Object.keys(data).length !== 1 ||
              !('kind' in data) ||
              data.kind !== 'ready'
            ) {
              const cause = new Error('Original worker startup handshake changed.');
              rejectReady(cause);
              reject(cause);
              return;
            }
            startupReceived = true;
            resolveReady();
            return;
          }
          value.off('message', onMessage);
          resolve(data as { dir: string; documentId: string; grantId: string; eventId: string });
        };
        const onExit = (code: number | null, signal: string | null) => {
          const cause = new Error(
            `Worker exited ${code} (${signal}) before checkpoint. ${output.stderr.toString('utf8')}`
          );
          rejectReady(cause);
          reject(cause);
        };
        const onError = (error: Error) => {
          rejectReady(error);
          reject(error);
        };
        value.on('message', onMessage);
        value.once('exit', onExit);
        value.once('error', onError);
        cancelCheckpoint = () => {
          value.off('message', onMessage);
          const cause = new Error('Crash test ended before checkpoint.');
          rejectReady(cause);
          reject(cause);
        };
      });
      void checkpoint.catch(() => {});
      return checkpoint;
    },
    async awaitReady() {
      if (!ready) throw new Error('Original startup is not captured.');
      await ready;
      assertActive();
    },
    async drain() {
      active = false;
      cancelCheckpoint?.();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await exited;
            await closed;
            await Promise.allSettled(pipes);
            if (task) await Promise.allSettled([task]);
            if (pipeFailed) throw firstPipeCause;
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Owned crash worker did not drain.')), 2000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async awaitExited() {
      if (!exited) throw new Error('No original crash worker captured.');
      await exited;
      assertActive();
    },
    async awaitClosed() {
      if (!closed) throw new Error('No original crash worker captured.');
      await closed;
      await Promise.allSettled(pipes);
      if (pipeFailed) throw firstPipeCause;
      assertActive();
    },
  };
  crashTests.push(owner);
  return owner;
}

// Load the original worker's modules as fixture setup, under Vitest's unchanged
// native hook budget (10 seconds). No Db, approval, checkpoint or effect runs yet.
let preloaded:
  | {
      owner: ReturnType<typeof crashTestOwnership>;
      child: ReturnType<typeof fork>;
      checkpoint: ReturnType<ReturnType<typeof crashTestOwnership>['capture']>;
    }
  | undefined;
beforeEach(async (context) => {
  const name = context.task.name;
  if (
    !['prepared', 'staged', 'replaced'].some(
      (point) => name === `recovers genuine process loss at ${point} without reapplying a marker`
    ) &&
    name !== 'drains its own crash worker when the genuine checkpoint fails before IPC'
  )
    return;
  const owner = crashTestOwnership();
  const child = fork(crashWorker.path, ['--await-original-case'], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const checkpoint = owner.capture(child, true);
  preloaded = { owner, child, checkpoint };
  await owner.awaitReady();
});
function takeOriginalPreloadedWorker() {
  if (!preloaded) throw new Error('Original worker fixture was not prepared.');
  const original = preloaded;
  preloaded = undefined;
  original.owner.assertActive();
  return original;
}
async function startOriginalCase(child: ReturnType<typeof fork>, point: string, seed: object) {
  await new Promise<void>((resolve, reject) =>
    child.send({ kind: 'start', point, seed: JSON.stringify(seed) }, (error) =>
      error ? reject(error) : resolve()
    )
  );
}

const cleanups: (() => Promise<void>)[] = [];
// Failed ownership stays UNKNOWN; later tests must not close/delete these resources.
const retainedCrashResources: {
  owners: { drain(): Promise<void> }[];
  cleanups: (() => Promise<void>)[];
}[] = [];
afterEach(async () => {
  preloaded = undefined;
  const owners = crashTests.splice(0);
  let drainFailed = false,
    firstDrainCause: unknown;
  await Promise.allSettled(
    owners.map(async (owner) => {
      try {
        await owner.drain();
      } catch (cause) {
        if (!drainFailed) {
          drainFailed = true;
          firstDrainCause = cause;
        }
        throw cause;
      }
    })
  );
  if (drainFailed) {
    retainedCrashResources.push({ owners, cleanups: cleanups.splice(0) });
    throw firstDrainCause;
  }
  let cleanupFailed = false,
    firstCleanupCause: unknown;
  await Promise.allSettled(
    cleanups.splice(0).map(async (cleanup) => {
      try {
        await cleanup();
      } catch (cause) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          firstCleanupCause = cause;
        }
        throw cause;
      }
    })
  );
  if (cleanupFailed) throw firstCleanupCause;
});
async function fixture(options: CheckboxServiceOptions = {}) {
  const h = await makeFixture(options);
  cleanups.push(h.cleanup);
  return h;
}

it.each(['prepared', 'staged', 'replaced'] as const)(
  'recovers genuine process loss at %s without reapplying a marker',
  async (point) => {
    const { owner, child, checkpoint } = takeOriginalPreloadedWorker();
    await owner.run(async () => {
      const seed = await fixture();
      owner.assertActive();
      const request = await seed.request();
      const originalPhysical = await stat(seed.path, { bigint: true });
      await seed.service.stop();
      seed.db.$client.close();
      owner.assertActive();
      await startOriginalCase(child, point, {
        dir: seed.dir,
        documentId: seed.documentId,
        grantId: seed.grantId,
        approved: seed.approved,
        request,
      });
      void checkpoint.catch(() => {});
      const message = await checkpoint;
      owner.assertActive();
      child.kill('SIGKILL');
      await owner.awaitExited();
      await owner.awaitClosed();
      owner.assertActive();
      const h = await makeFixture({}, message);
      cleanups.push(h.cleanup);
      owner.assertActive();
      const original = h.row();
      expect(original.eventId).toBe(message.eventId);
      expect(original.status).toBe('prepared');
      expect(h.service.validate(original)).toMatchObject({
        v: 2,
        originalIdentity: {
          device: String(originalPhysical.dev),
          inode: String(originalPhysical.ino),
        },
      });
      const bytes = await readFile(h.path),
        inode = (await stat(h.path)).ino;
      const receipt = await h.service.recover(original.intentId);
      expect(receipt.status).toBe(point === 'replaced' ? 'changed' : 'in_doubt');
      expect(await readFile(h.path)).toEqual(bytes);
      expect((await stat(h.path)).ino).toBe(inode);
      expect(h.counts()).toEqual({
        events: { n: point === 'replaced' ? 2 : 0 },
        batches: { n: point === 'replaced' ? 1 : 0 },
      });
      if (point === 'replaced') expect(await h.service.recover(original.intentId)).toEqual(receipt);
      expect(h.row().envelopeHash).toBe(original.envelopeHash);
      expect((await readdir(h.dir)).filter((name) => name.startsWith('.dork-checkbox-'))).toEqual(
        []
      );
    });
  }
);

it('drains its own crash worker when the genuine checkpoint fails before IPC', async () => {
  const { owner, child, checkpoint } = takeOriginalPreloadedWorker();
  await owner.run(async () => {
    const seed = await fixture();
    owner.assertActive();
    const request = { ...(await seed.request()), expectedFileVersion: '0'.repeat(64) };
    const before = await readFile(seed.path);
    await seed.service.stop();
    seed.db.$client.close();
    owner.assertActive();
    await startOriginalCase(child, 'prepared', {
      dir: seed.dir,
      documentId: seed.documentId,
      grantId: seed.grantId,
      approved: seed.approved,
      request,
    });
    await expect(checkpoint).rejects.toThrow('before checkpoint');
    await owner.awaitClosed();
    expect(child.exitCode).toBe(1);
    owner.assertActive();
    const reopened = await makeFixture({}, seed);
    cleanups.push(reopened.cleanup);
    owner.assertActive();
    expect(await readFile(reopened.path)).toEqual(before);
    expect(reopened.row()).toMatchObject({ eventId: request.eventId, status: 'conflict' });
    expect(reopened.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  });
});

it('drains a held pre-checkpoint child and retires its late fixture continuation', async () => {
  const owner = crashTestOwnership();
  const seed = await fixture();
  const request = await seed.request();
  const before = await readFile(seed.path);
  await seed.service.stop();
  seed.db.$client.close();
  owner.assertActive();
  const child = fork(
    crashWorker.path,
    [
      'prepared',
      JSON.stringify({
        dir: seed.dir,
        documentId: seed.documentId,
        grantId: seed.grantId,
        approved: seed.approved,
        request,
      }),
    ],
    { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  const checkpoint = owner.capture(child);
  const closed = once(child, 'close');
  let fixtureContinuations = 0;
  const continuation = owner.run(async () => {
    await checkpoint;
    owner.assertActive();
    fixtureContinuations += 1;
    owner.assertActive();
    const reopened = await makeFixture({}, seed);
    cleanups.push(reopened.cleanup);
  });
  const refusal = expect(continuation).rejects.toThrow('ended before checkpoint');
  await once(child, 'spawn');
  try {
    await owner.drain();
    await refusal;
    expect(child.signalCode).toBe('SIGKILL');
    expect(fixtureContinuations).toBe(0);
    expect(() => owner.assertActive()).toThrow('Crash test ended');
    expect(await readFile(seed.path)).toEqual(before);
  } finally {
    // Also owns cleanup if the drain implementation is deliberately broken by a control.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await Promise.allSettled([continuation]);
  }
  // A test can end while an earlier genuine fixture phase is awaited, before fork exists.
  const lateOwner = crashTestOwnership();
  let release!: () => void;
  const heldBeforeFork = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lateChild: ReturnType<typeof fork> | undefined;
  let lateClosed: Promise<unknown> | undefined;
  const lateTask = lateOwner.run(async () => {
    await heldBeforeFork;
    lateOwner.assertActive();
    lateChild = fork(
      crashWorker.path,
      [
        'prepared',
        JSON.stringify({
          dir: seed.dir,
          documentId: seed.documentId,
          grantId: seed.grantId,
          approved: seed.approved,
          request,
        }),
      ],
      { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    );
    lateClosed = once(lateChild, 'close');
    lateChild.stdout!.resume();
    lateChild.stderr!.resume();
    await lateOwner.capture(lateChild);
  });
  const lateRefusal = expect(lateTask).rejects.toThrow('Crash test ended');
  try {
    const drain = lateOwner.drain();
    release();
    await drain;
    await lateRefusal;
    expect(lateChild).toBeUndefined();
    expect(await readFile(seed.path)).toEqual(before);
  } finally {
    release();
    // Own exact fallback for the deliberate pre-fork guard omission control.
    if (lateChild && lateChild.exitCode === null && lateChild.signalCode === null)
      lateChild.kill('SIGKILL');
    if (lateClosed) await lateClosed;
    await Promise.allSettled([lateTask]);
  }
});
