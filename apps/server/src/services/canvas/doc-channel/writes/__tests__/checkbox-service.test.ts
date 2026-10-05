import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  readFile,
  realpath,
  rename,
  stat,
  chmod,
  writeFile,
  readdir,
  link,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canvasDocChannels, canvasDocWriteIntents, type DbTransaction } from '@dorkos/db';
import { fixture as makeFixture, AuthorityRefused } from './checkbox-fixture.js';
import { DocCheckboxWriteService } from '../checkbox-service.js';
import {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentityChangedError,
} from '../canonical-writer.js';
import type {
  CheckboxRequest,
  VerifiedCheckboxAuthority,
  CheckboxServiceOptions,
} from '../checkbox-service.js';
import type { DocCheckboxAuthority } from '../authority.js';
import { DocChannelNotFoundError, type DocChannelActor } from '../../authorization.js';
import type { DocWriteIntentRow } from '../../store.js';
import { rawByteHash } from '../checkbox-bytes.js';
import { recoverCheckboxPage } from '../write-recovery.js';
import { VerifiedCheckboxAuthoritySchema } from '../checkbox-evidence.js';
import { observeCheckboxSource } from '../authority-snapshot.js';
import { readDocSourceDescriptor } from '../../http-composition.js';

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
  const child = fork(
    fileURLToPath(new URL('./checkbox-crash-worker.ts', import.meta.url)),
    ['--await-original-case'],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
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
it('writes exactly one raw marker, preserves mode/BOM/CRLF and atomically completes original event/outbox/receipt', async () => {
  const h = await fixture();
  await chmod(h.path, 0o640);
  const input = await h.request();
  const before = await readFile(h.path);
  const result = await h.service.toggle(input, h.actor);
  expect(result.status).toBe('changed');
  const after = await readFile(h.path);
  expect([...after].filter((value, index) => value !== before[index])).toHaveLength(1);
  expect(after.toString()).toBe('\ufeff- [x] café😀\r\n- [ ] repeated\r\n');
  expect((await stat(h.path)).mode & 0o777).toBe(0o640);
  expect(h.row().status).toBe('committed');
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(result);
  expect(await h.service.toggle({ ...input, done: false }, h.actor)).toMatchObject({
    status: 'conflict',
  });
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.notices).toEqual([h.documentId]);
});
it('no-op and verified stale version produce durable original receipts and no changed work', async () => {
  const h = await fixture();
  const noOp = await h.request(false);
  expect((await h.service.toggle(noOp, h.actor)).status).toBe('no_op');
  const conflict = { ...(await h.request()), expectedFileVersion: '0'.repeat(64) };
  expect((await h.service.toggle(conflict, h.actor)).status).toBe('conflict');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it('checks current grant/editor lock before effects and rechecks authority after async staging', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'staged') h.revoke();
    },
  });
  const before = await readFile(h.path);
  const input = await h.request();
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow('The document is not available.');
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('prepared');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  const other = await fixture();
  other.lock();
  await expect(other.service.toggle(await other.request(), other.actor)).rejects.toThrow(
    'EDITOR_LOCKED'
  );
  expect(other.row()).toBeUndefined();
});
it('post-effect revoked authority retains evidence and fence without completing work', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'verified') h.revoke();
    },
  });
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow(
    'The document is not available.'
  );
  expect((await readFile(h.path)).toString()).toContain('[x]');
  expect(h.row().status).toBe('replaced');
  expect(h.service.fenced(h.path)).toBe(true);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it('completion rollback preserves replaced evidence and recovery commits once without another rename', async () => {
  const h = await fixture();
  h.failCompletion(true);
  const input = await h.request();
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow('completion rollback');
  expect(h.row().status).toBe('replaced');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  const inode = (await stat(h.path)).ino;
  h.failCompletion(false);
  const [a, b] = await Promise.all([
    h.service.recover(h.row().intentId),
    h.service.recover(h.row().intentId),
  ]);
  expect(a).toEqual(b);
  expect(a.status).toBe('changed');
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});
it('rejects async genuine authority scopes, retires SQL handles and rolls back late writes', async () => {
  const h = await fixture();
  let late!: Promise<unknown>;
  const callback = (tx: DbTransaction) => {
    late = Promise.resolve().then(() =>
      tx.update(canvasDocChannels).set({ closedAt: new Date().toISOString() }).run()
    );
    return late;
  };
  expect(() =>
    h.authority.transaction(callback as unknown as (tx: DbTransaction) => undefined)
  ).toThrow('synchronous');
  await expect(late).rejects.toThrow();
  expect(h.store.getChannel(h.documentId)?.closedAt).toBeNull();
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it('stop drains held FS preparation before DB disposal and prevents completion', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    start = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const h = await fixture({
    checkpoint: async (point) => {
      if (point === 'prepared') {
        entered();
        await held;
      }
    },
  });
  const operation = h.service.toggle(await h.request(), h.actor);
  const refusal = expect(operation).rejects.toThrow('not available');
  await start;
  let drained = false;
  const stop = h.service.stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await stop;
  await refusal;
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  await expect(recoverCheckboxPage(h.service)).rejects.toThrow('not available');
});
it('quarantines corrupted evidence and unknown after-state, retaining path fences and zero changed work', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  await writeFile(h.path, 'external unknown');
  expect((await h.service.recover(h.row().intentId)).status).toBe('in_doubt');
  expect(h.service.fenced(h.path)).toBe(true);
  h.db.$client.prepare("UPDATE canvas_doc_write_intents SET evidence='{}'").run();
  const page = await recoverCheckboxPage(h.service);
  expect(page).toMatchObject({ selected: 1, verified: 0, retryableFailures: 1, hasMore: false });
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('requires current access before duplicate disclosure without reinterpreting original inputs', async () => {
  const h = await fixture();
  const input = await h.request();
  const original = await h.service.toggle(input, h.actor);
  const hash = h.row().envelopeHash;
  h.db.update(canvasDocChannels).set({ closedAt: new Date().toISOString() }).run();
  await expect(h.service.toggle(input, h.actor)).rejects.toBeInstanceOf(AuthorityRefused);
  expect(h.row().envelopeHash).toBe(hash);
  h.db.update(canvasDocChannels).set({ closedAt: null }).run();
  expect(await h.service.toggle(input, h.actor)).toEqual(original);
  expect(h.row().envelopeHash).toBe(hash);
});
it('retains replaced evidence on transient recovery errors and quarantines only typed authority loss', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  const original = h.row();
  h.authority.prepareRecovery = async () => {
    throw new Error('storage unavailable');
  };
  await expect(h.service.recover(original.intentId)).rejects.toThrow('storage unavailable');
  expect(h.row()).toEqual(original);
  h.authority.prepareRecovery = async () => {
    throw h.lostAuthority();
  };
  await expect(h.service.recover(original.intentId)).rejects.toBeInstanceOf(AuthorityRefused);
  expect(h.row().status).toBe('in_doubt');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it.each(['thenable', 'throw', 'nonboolean'] as const)(
  'classification %s never destroys retryable recovery evidence',
  async (kind) => {
    const h = await fixture();
    h.failCompletion(true);
    await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
    const original = h.row();
    h.authority.prepareRecovery = async () => {
      throw new Error('unavailable');
    };
    h.authority.isAuthorityRefusal = (() => {
      if (kind === 'throw') throw new Error('classifier unavailable');
      if (kind === 'thenable') return Promise.reject(new Error('late classifier'));
      return 'yes';
    }) as unknown as DocCheckboxAuthority['isAuthorityRefusal'];
    await expect(h.service.recover(original.intentId)).rejects.toThrow('unavailable');
    await Promise.resolve();
    expect(h.row()).toEqual(original);
  }
);
it('does not invoke a replaced async public authority method or expose its actual SQL handle', async () => {
  const h = await fixture();
  const input = await h.request(),
    before = await readFile(h.path);
  let calls = 0,
    exposed: DbTransaction | undefined;
  h.authority.requireCurrent = (async (
    _request: CheckboxRequest,
    _actor: DocChannelActor,
    _approved: VerifiedCheckboxAuthority,
    _snapshot: Parameters<DocCheckboxAuthority['requireCurrent']>[3],
    tx: DbTransaction
  ) => {
    calls++;
    exposed = tx;
    await Promise.resolve();
    return h.approved;
  }) as unknown as DocCheckboxAuthority['requireCurrent'];
  const receipt = await h.service.toggle(input, h.actor);
  await Promise.resolve();
  expect(calls).toBe(0);
  expect(exposed).toBeUndefined();
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: input.eventId } });
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  expect([...bytes].filter((value, index) => value !== before[index])).toHaveLength(1);
  expect(bytes).toEqual(Buffer.from('\ufeff- [x] café😀\r\n- [ ] repeated\r\n'));
  expect(h.row()).toMatchObject({
    eventId: input.eventId,
    grantId: h.grantId,
    status: 'committed',
  });
  expect(h.store.getChannel(h.documentId)?.closedAt).toBeNull();
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
  expect(h.service.validate(h.row()).receipt).toEqual(receipt);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect(await readFile(h.path)).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
});

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
    fileURLToPath(new URL('./checkbox-crash-worker.ts', import.meta.url)),
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
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
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
      fileURLToPath(new URL('./checkbox-crash-worker.ts', import.meta.url)),
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
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
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

it('refuses a newer grant revision after staging and freezes the original approval evidence', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'staged')
        h.db.$client.prepare('UPDATE canvas_doc_grants SET revision=revision+1').run();
    },
  });
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('in_doubt');
  expect(
    h.service.validate(h.store.getWriteIntent(h.row().intentId)!).authority.grantRevision
  ).toBe(1);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it.each(['staged', 'verified'] as const)(
  'external byte changes at %s never produce routable changed work',
  async (point) => {
    const h: Awaited<ReturnType<typeof fixture>> = await fixture({
      checkpoint: async (current) => {
        if (current === point) await writeFile(h.path, 'external source');
      },
    });
    await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('changed');
    expect(await readFile(h.path, 'utf8')).toBe('external source');
    expect(h.row().status).toBe('in_doubt');
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  }
);
it('recovery rejects internally inconsistent marker evidence even when the after hash matches', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  h.db.$client
    .prepare("UPDATE canvas_doc_write_intents SET evidence=json_set(evidence,'$.markerOffset',20)")
    .run();
  await expect(h.service.recover(h.row().intentId)).rejects.toThrow(
    'Checkbox reconstructed source differs.'
  );
  expect(h.row().status).toBe('in_doubt');
  expect(h.service.fenced(h.path)).toBe(true);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('rechecks changed same-ID evidence after a successful fence scan', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(h.service.writeFence.readiness()).toEqual({ ready: true });
  h.db.$client.prepare("UPDATE canvas_doc_write_intents SET before_hash='invalid'").run();
  expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'corrupt' });
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('recovery reads retain the fresh global corruption fence after validation reuse', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  const own = h.store.getWriteIntent(h.row().intentId)!;
  const intentId = randomUUID(),
    eventId = randomUUID();
  const input = { ...(own.input as CheckboxRequest), eventId };
  const other = {
    ...own,
    intentId,
    eventId,
    input,
    envelopeHash: rawByteHash(Buffer.from(JSON.stringify(input))),
    evidence: {
      ...h.service.validate(own),
      tempPath: join(h.dir, `.dork-checkbox-${intentId}.tmp`),
    },
  };
  h.store.transaction((tx) => tx.insert(canvasDocWriteIntents).values(other).run());
  const info = await stat(h.path, { bigint: true });
  const identity = {
    canonicalPath: await realpath(h.path),
    device: String(info.dev),
    inode: String(info.ino),
  };
  h.service.writeFence.assertRecoveryRead(identity, own);
  h.service.writeFence.assertRecoveryRead(identity, own);
  h.db.$client
    .prepare("UPDATE canvas_doc_write_intents SET evidence='{}' WHERE intent_id=?")
    .run(intentId);
  expect(() => h.service.writeFence.assertRecoveryRead(identity, own)).toThrow('unavailable');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('bounded recovery progresses through 101 original intents with a stable keyset and no effects', async () => {
  const startedAt = performance.now();
  const phase = (name: string, count?: number) =>
    process.stderr.write(
      `checkbox-101-phase ${JSON.stringify({ name, count, elapsedMs: performance.now() - startedAt })}\n`
    );
  phase('start');
  const h = await fixture();
  phase('fixture');
  const before = await readFile(h.path);
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  await writeFile(h.path, before);
  phase('failed-toggle-and-source-restored');
  const base = h.store.getWriteIntent(h.row().intentId)!;
  h.db.$client.prepare("UPDATE canvas_doc_write_intents SET status='prepared'").run();
  for (let i = 0; i < 100; i++) {
    const intentId = randomUUID(),
      eventId = randomUUID();
    const input = { ...(base.input as CheckboxRequest), eventId };
    const evidence = {
      ...h.service.validate(base),
      tempPath: join(h.dir, `.dork-checkbox-${intentId}.tmp`),
    };
    const seeded = {
      ...base,
      intentId,
      eventId,
      input,
      envelopeHash: rawByteHash(Buffer.from(JSON.stringify(input))),
      evidence,
      status: 'prepared' as const,
    };
    h.service.validate(seeded);
    // Synthetic census setup; ordinary admission and its UUID guards are tested separately.
    h.store.transaction((tx) => tx.insert(canvasDocWriteIntents).values(seeded).run());
    h.service.validate(h.store.getWriteIntent(intentId)!);
  }
  phase('seeded', 101);
  // Temporary diagnostics delegate the exact methods used dynamically by recover().
  // Timings are inclusive: prepareRecovery contains refreshRecoveryCurrent.
  const totals = {
    prepare: { calls: 0, ms: 0 },
    refresh: { calls: 0, ms: 0 },
    require: { calls: 0, ms: 0 },
    fence: { calls: 0, ms: 0 },
  };
  const prepare = h.authority.prepareRecovery.bind(h.authority);
  const refresh = h.authority.refreshRecoveryCurrent.bind(h.authority);
  const requireCurrent = h.authority.requireRecoveryCurrent.bind(h.authority);
  const fence = h.service.writeFence.assertRecoveryRead.bind(h.service.writeFence);
  const probes = [
    vi.spyOn(h.authority, 'prepareRecovery').mockImplementation(async (...args) => {
      const start = performance.now();
      totals.prepare.calls++;
      try {
        return await prepare(...args);
      } finally {
        totals.prepare.ms += performance.now() - start;
      }
    }),
    vi.spyOn(h.authority, 'refreshRecoveryCurrent').mockImplementation(async (...args) => {
      const start = performance.now();
      totals.refresh.calls++;
      try {
        return await refresh(...args);
      } finally {
        totals.refresh.ms += performance.now() - start;
      }
    }),
    vi.spyOn(h.authority, 'requireRecoveryCurrent').mockImplementation((...args) => {
      const start = performance.now();
      totals.require.calls++;
      try {
        return requireCurrent(...args);
      } finally {
        totals.require.ms += performance.now() - start;
      }
    }),
    vi.spyOn(h.service.writeFence, 'assertRecoveryRead').mockImplementation((...args) => {
      const start = performance.now();
      totals.fence.calls++;
      try {
        return fence(...args);
      } finally {
        totals.fence.ms += performance.now() - start;
      }
    }),
  ];
  cleanups.push(async () => {
    await h.service.stop();
    for (const probe of probes) probe.mockRestore();
  });
  const reportTotals = () => process.stderr.write(`checkbox-101-cost ${JSON.stringify(totals)}\n`);
  const one = await recoverCheckboxPage(h.service);
  reportTotals();
  phase('page-one', one.selected);
  expect(one).toMatchObject({ selected: 100, verified: 0, retryableFailures: 0, hasMore: true });
  const two = await recoverCheckboxPage(h.service, one.cursor);
  phase('page-two', two.selected);
  reportTotals();
  expect(two).toMatchObject({ selected: 1, verified: 0, retryableFailures: 0, hasMore: false });
  expect(one.cursor).not.toEqual(two.cursor);
  expect(await readFile(h.path)).toEqual(before);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  await expect(
    recoverCheckboxPage(h.service, { updatedAt: 'invalid', intentId: 'x' })
  ).rejects.toThrow('cursor');
  await expect(recoverCheckboxPage(h.service, undefined, 101)).rejects.toThrow('limit');
  phase('assertions-complete');
});

it('does not remove an unowned exclusive-create collider during failure or recovery', async () => {
  let colliding = '';
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point, intent) => {
      if (point === 'prepared') {
        colliding = join(h.dir, `.dork-checkbox-${intent.intentId}.tmp`);
        await writeFile(colliding, 'unowned');
      }
    },
  });
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await readFile(colliding, 'utf8')).toBe('unowned');
  expect((await h.service.recover(h.row().intentId)).status).toBe('in_doubt');
  expect(await readFile(colliding, 'utf8')).toBe('unowned');
  expect(await readFile(h.path)).toEqual(before);
});
it('rejects replaced staging inode before it can replace the source', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point, intent) => {
      if (point === 'staged') {
        const path = join(h.dir, `.dork-checkbox-${intent.intentId}.tmp`);
        const replacement = path + '.replacement';
        await writeFile(replacement, 'unowned replacement');
        expect((await stat(replacement, { bigint: true })).ino).not.toBe(
          (await stat(path, { bigint: true })).ino
        );
        await rename(replacement, path);
      }
    },
  });
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('replacement');
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('in_doubt');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('retains the actual replacement lease against a new cooperating hardlink writer until host completion', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'replaced') {
        entered();
        await held;
      }
    },
  });
  const input = await h.request();
  const operation = h.service.toggle(input, h.actor);
  await started;
  const alias = join(h.dir, 'alias');
  await link(h.path, alias);
  let writes = 0;
  const other = h.coordinator.withFiles([alias], async () => {
    writes++;
    await writeFile(alias, 'cooperating next write');
  });
  let result;
  try {
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(writes).toBe(0);
  } finally {
    release();
    result = await operation;
    await other;
  }
  expect(result!.status).toBe('changed');
  expect(writes).toBe(1);
  expect(h.row().status).toBe('committed');
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(result);
});

it('cleans its exclusively-created temp if current grant is lost before staging can commit', async () => {
  const h = await fixture();
  const refresh = h.authority.refreshCurrent.bind(h.authority);
  let checks = 0;
  h.authority.refreshCurrent = (...args) => {
    if (++checks === 2) h.revoke();
    return refresh(...args);
  };
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('prepared');
  expect((await readdir(h.dir)).filter((name) => name.startsWith('.dork-checkbox-'))).toEqual([]);
});

it('retains exact evidence when a genuine exclusive SQLite read lock is released before recovery handles its error', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  const original = h.row(),
    reader = h.store.getWriteIntent.bind(h.store),
    lock = new Database(h.file);
  h.db.$client.pragma('busy_timeout = 0');
  h.db.$client.pragma('journal_mode = DELETE');
  lock.exec('BEGIN EXCLUSIVE');
  h.store.getWriteIntent = (...args) => {
    try {
      return reader(...args);
    } catch (error) {
      lock.exec('ROLLBACK');
      throw error;
    }
  };
  try {
    await expect(h.service.recover(original.intentId)).rejects.toThrow();
    expect(h.row()).toEqual(original);
  } finally {
    if (lock.inTransaction) lock.exec('ROLLBACK');
    lock.close();
    h.store.getWriteIntent = reader;
  }
});

it('ignores a replaced public method that attempts to rewrite the original frozen approval', async () => {
  const h = await fixture();
  const input = await h.request(),
    before = await readFile(h.path);
  const originalGrant = h.store.getGrant(h.grantId);
  let calls = 0;
  h.authority.requireCurrent = (_request, _actor, approved) => {
    calls++;
    approved.grantRevision++;
    return approved;
  };
  const receipt = await h.service.toggle(input, h.actor);
  expect(calls).toBe(0);
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: input.eventId } });
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  expect([...bytes].filter((value, index) => value !== before[index])).toHaveLength(1);
  expect(bytes).toEqual(Buffer.from('\ufeff- [x] café😀\r\n- [ ] repeated\r\n'));
  expect(h.row()).toMatchObject({
    eventId: input.eventId,
    grantId: h.grantId,
    status: 'committed',
  });
  expect(h.service.validate(h.row()).authority.grantRevision).toBe(1);
  expect(h.store.getGrant(h.grantId)).toEqual(originalGrant);
  expect(h.service.fenced(h.path)).toBe(false);
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
  expect(h.service.validate(h.row()).receipt).toEqual(receipt);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect(await readFile(h.path)).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
});

async function simultaneous(
  kind: 'distinct' | 'same' | 'different-hash' = 'distinct',
  resolveError?: Error,
  expectedFileVersion?: string
) {
  const h = await fixture();
  let release!: () => void, entered!: () => void, queued!: () => void, prepareBoth!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    prepared = new Promise<void>((r) => {
      entered = r;
    }),
    pending = new Promise<void>((r) => {
      queued = r;
    }),
    both = new Promise<void>((r) => {
      prepareBoth = r;
    });
  let calls = 0,
    preparations = 0,
    firstEventId = '',
    firstDone = true;
  const prepare = h.authority.prepare.bind(h.authority);
  h.authority.prepare = async (...args) => {
    const result = await prepare(...args);
    if (++preparations === 2) prepareBoth();
    await both;
    if (args[0].eventId !== firstEventId || args[0].done !== firstDone) await prepared;
    return result;
  };
  const coordinator = new CanonicalFileWriteCoordinator({
    assertOutsideTransaction: () => {
      if (h.db.$client.inTransaction) throw new Error('SQL boundary');
    },
    resolve: async (path) => {
      const canonicalPath = await realpath(path),
        info = await stat(path, { bigint: true });
      if (++calls === 3) queued();
      if (calls === 5 && resolveError) throw resolveError;
      return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
    },
  });
  let afterCommit = () => undefined;
  const service = new DocCheckboxWriteService(
    h.db,
    h.store,
    coordinator,
    h.authority,
    {
      ...h.delivery,
      notifyCommitted: (id: string) => {
        h.delivery.notifyCommitted(id);
        afterCommit();
        return undefined;
      },
    },
    {
      checkpoint: async (point) => {
        if (point === 'prepared') {
          entered();
          await held;
        }
      },
    }
  );
  cleanups.unshift(() => service.stop());
  const firstInput = await h.request(),
    secondInput =
      kind === 'distinct'
        ? {
            ...(await h.request()),
            ...(expectedFileVersion === undefined ? {} : { expectedFileVersion }),
          }
        : { ...firstInput, done: kind === 'same' ? firstInput.done : !firstInput.done };
  firstEventId = firstInput.eventId;
  firstDone = firstInput.done;
  const first = service.toggle(firstInput, h.actor);
  const second = service.toggle(secondInput, h.actor).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error: error as unknown })
  );
  await prepared;
  await pending;
  return {
    ...h,
    service,
    firstInput,
    secondInput,
    release,
    first,
    second,
    afterCommit: (work: () => undefined) => {
      afterCommit = work;
    },
  };
}
it('records a typed durable reload conflict for the exact simultaneous distinct stale-save case', async () => {
  const h = await simultaneous();
  h.release();
  const first = await h.first,
    second = await h.second;
  expect(first.status).toBe('changed');
  expect(second.value).toEqual({
    status: 'conflict',
    eventId: h.secondInput.eventId,
    action: 'reload',
  });
  const row = h.service.find(h.documentId, h.secondInput.eventId)!;
  expect(row).toMatchObject({
    status: 'conflict',
    errorCode: 'identity_changed_before_effect',
    input: h.secondInput,
    expectedVersion: h.secondInput.expectedFileVersion,
  });
  expect(h.service.validate(row)).toMatchObject({
    preEffectRefusal: 'identity_changed',
    markerOffset: null,
    beforeMarker: null,
    tempPath: null,
    tempIdentity: null,
    lineHash: null,
  });
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  const inode = (await stat(h.path)).ino;
  expect(await h.service.toggle(h.secondInput, h.actor)).toEqual(second.value);
  expect(await h.service.recover(row.intentId)).toEqual(second.value);
  expect((await stat(h.path)).ino).toBe(inode);
});
it.each(['same', 'different-hash'] as const)(
  'simultaneous %s identity preserves the original receipt/hash without another intent',
  async (kind) => {
    const h = await simultaneous(kind);
    h.release();
    const first = await h.first,
      second = await h.second;
    expect(second.value).toEqual(
      kind === 'same'
        ? first
        : { status: 'conflict', eventId: h.firstInput.eventId, action: 'reload' }
    );
    expect(
      h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()
    ).toEqual({ n: 1 });
    expect(h.service.find(h.documentId, h.firstInput.eventId)!.envelopeHash).toBe(
      rawByteHash(Buffer.from(JSON.stringify(h.firstInput)))
    );
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  }
);
it.each(['access', 'revoked', 'binding'] as const)(
  'does not turn current %s refusal after waiting into a version conflict',
  async (kind) => {
    const h = await simultaneous();
    h.afterCommit(() => {
      if (kind === 'access')
        h.db.update(canvasDocChannels).set({ closedAt: new Date().toISOString() }).run();
      if (kind === 'revoked') h.revoke();
      if (kind === 'binding')
        h.db.$client
          .prepare(
            "UPDATE canvas_doc_grants SET write_operation=json_set(write_operation,'$.canonicalPath',?)"
          )
          .run(join(h.dir, 'moved.md'));
      return undefined;
    });
    h.release();
    expect((await h.first).status).toBe('changed');
    const refusal = (await h.second).error;
    if (kind === 'binding') expect(refusal).toMatchObject({ code: 'GRANT_EVIDENCE_MISMATCH' });
    else if (kind === 'access') expect(refusal).toMatchObject({ code: 'DOCUMENT_CLOSED' });
    else expect(refusal).toBeInstanceOf(DocChannelNotFoundError);
    expect(h.service.find(h.documentId, h.secondInput.eventId)).toBeUndefined();
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  }
);
it('does not launder corrupt original same-ID evidence into a normal hash conflict', async () => {
  const h = await simultaneous('different-hash');
  h.afterCommit(() => {
    expect(h.db.$client.inTransaction).toBe(false);
    h.db.$client.prepare("UPDATE canvas_doc_write_intents SET evidence='{}'").run();
    return undefined;
  });
  h.release();
  expect((await h.first).status).toBe('changed');
  expect((await h.second).error).toBeTruthy();
  expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()).toEqual({
    n: 1,
  });
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});
it('preserves arbitrary pre-callback resolver IO errors without a fabricated conflict', async () => {
  const error = new Error('temporary IO');
  const h = await simultaneous('distinct', error);
  h.release();
  await h.first;
  expect((await h.second).error).toBe(error);
  expect(h.service.find(h.documentId, h.secondInput.eventId)).toBeUndefined();
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});
it('rolls back a refused conflict insert without masking its real SQLite storage error', async () => {
  const h = await simultaneous();
  h.db.$client.exec(
    "CREATE TRIGGER refuse_conflict BEFORE INSERT ON canvas_doc_write_intents WHEN NEW.status='conflict' BEGIN SELECT RAISE(ABORT,'conflict storage refused'); END"
  );
  h.release();
  await h.first;
  expect((await h.second).error).toBeTruthy();
  expect(h.service.find(h.documentId, h.secondInput.eventId)).toBeUndefined();
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});
it('does not reinterpret identity-class errors from an already-entered callback as pre-effect conflicts', async () => {
  const error = new CanonicalFileIdentityChangedError();
  const h = await fixture({
    checkpoint: async (point) => {
      if (point === 'verified') throw error;
    },
  });
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toBe(error);
  expect(h.row().status).toBe('replaced');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

async function fileBackedFixture() {
  const h = await fixture();
  expect(h.documentId).toMatch(/^[a-f0-9]{32}$/);
  expect(h.rooms.canvasDocuments.lookupIdentity(h.documentId)?.sourceKey).not.toBeNull();
  return h;
}
it('accepts actual file-backed document identifiers through write, original retry and recovery without a second effect', async () => {
  const h = await fileBackedFixture();
  const input = await h.request();
  const before = await readFile(h.path);
  h.failCompletion(true);
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow('completion rollback');
  expect(h.row()).toMatchObject({
    documentId: h.documentId,
    eventId: input.eventId,
    status: 'replaced',
  });
  const after = await readFile(h.path);
  expect([...after].filter((v, i) => v !== before[i])).toHaveLength(1);
  const inode = (await stat(h.path)).ino;
  h.failCompletion(false);
  const receipt = await h.service.recover(h.row().intentId);
  expect(receipt).toMatchObject({ receipt: { id: input.eventId }, status: 'changed' });
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(await readFile(h.path)).toEqual(after);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
  expect(h.notices).toEqual([h.documentId]);
});
it.each(['', 'x'.repeat(201)])(
  'rejects malformed document identity in requests and stored authority: %s',
  async (documentId) => {
    const h = await fixture();
    const input = await h.request();
    expect(VerifiedCheckboxAuthoritySchema.safeParse({ ...h.approved, documentId }).success).toBe(
      false
    );
    await expect(h.service.toggle({ ...input, documentId }, h.actor)).rejects.toThrow();
    expect(h.row()).toBeUndefined();
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  }
);

it.each(['not-a-sha256', 'opaque-revision:λ', 'v'.repeat(500)])(
  'preserves opaque request version in unobserved pre-effect refusal through validation, retry and recovery: %s',
  async (version) => {
    const h = await simultaneous('distinct', undefined, version);
    h.release();
    expect((await h.first).status).toBe('changed');
    const second = await h.second;
    expect(second.error).toBeUndefined();
    expect(second.value).toEqual({
      status: 'conflict',
      eventId: h.secondInput.eventId,
      action: 'reload',
    });
    const row = h.service.find(h.documentId, h.secondInput.eventId)!;
    expect(row).toMatchObject({
      beforeHash: version,
      afterHash: version,
      expectedVersion: version,
      input: h.secondInput,
      errorCode: 'identity_changed_before_effect',
    });
    expect(h.service.validate(row)).toMatchObject({
      preEffectRefusal: 'identity_changed',
      markerOffset: null,
      beforeMarker: null,
      lineHash: null,
      tempPath: null,
      tempIdentity: null,
    });
    const before = await readFile(h.path),
      inode = (await stat(h.path)).ino;
    expect(await h.service.toggle(h.secondInput, h.actor)).toEqual(second.value);
    expect(await h.service.recover(row.intentId)).toEqual(second.value);
    expect(h.service.find(h.documentId, h.secondInput.eventId)).toEqual(row);
    expect((await stat(h.path)).ino).toBe(inode);
    expect(await readFile(h.path)).toEqual(before);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  }
);
it('keeps opaque ordinary observed conflicts valid while requiring real observed hashes', async () => {
  const h = await fixture();
  const input = { ...(await h.request()), expectedFileVersion: 'not-a-sha256' };
  const before = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const receipt = await h.service.toggle(input, h.actor);
  expect(receipt).toEqual({ status: 'conflict', eventId: input.eventId, action: 'reload' });
  const row = h.row();
  expect(row.beforeHash).toBe(rawByteHash(before));
  expect(row.afterHash).toBe(rawByteHash(before));
  expect(h.service.validate(row).preEffectRefusal).toBeUndefined();
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect(await h.service.recover(row.intentId)).toEqual(receipt);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(() =>
    h.service.validate({
      ...row,
      beforeHash: input.expectedFileVersion,
      afterHash: input.expectedFileVersion,
    })
  ).toThrow();
  expect(() =>
    h.service.validate({
      ...row,
      evidence: { ...h.service.validate(row), preEffectRefusal: 'identity_changed' },
    })
  ).toThrow();
});
it.each(['', 'v'.repeat(501)])(
  'refuses versions outside the shared opaque domain before any durable work: %s',
  async (version) => {
    const h = await fixture();
    const input = { ...(await h.request()), expectedFileVersion: version };
    const before = await readFile(h.path);
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(h.row()).toBeUndefined();
    expect(await readFile(h.path)).toEqual(before);
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  }
);
it('does not let forged terminal flags bypass status, original version, identity or observed proof checks', async () => {
  const h = await simultaneous('distinct', undefined, 'opaque-version');
  h.release();
  await h.first;
  await h.second;
  const row = h.service.find(h.documentId, h.secondInput.eventId)!;
  const evidence = h.service.validate(row);
  const mutations: DocWriteIntentRow[] = [
    { ...row, status: 'prepared' },
    { ...row, status: 'replaced' },
    { ...row, errorCode: 'source_conflict' },
    { ...row, beforeHash: 'different-version' },
    { ...row, afterHash: 'different-version' },
    { ...row, expectedVersion: 'different-version' },
    { ...row, evidence: { ...evidence, preEffectRefusal: undefined } },
    { ...row, evidence: { ...evidence, markerOffset: 5 } },
    { ...row, evidence: { ...evidence, beforeMarker: 32 } },
    { ...row, evidence: { ...evidence, lineHash: 'a'.repeat(64) } },
    { ...row, evidence: { ...evidence, tempPath: h.path } },
    { ...row, evidence: { ...evidence, tempIdentity: { device: '1', inode: '2' } } },
    {
      ...row,
      evidence: {
        ...evidence,
        receipt: { status: 'conflict', eventId: randomUUID(), action: 'reload' },
      },
    },
    {
      ...row,
      evidence: {
        ...evidence,
        receipt: { status: 'no_op', eventId: row.eventId, fileVersion: row.beforeHash },
      },
    },
  ];
  for (const corrupt of mutations) expect(() => h.service.validate(corrupt)).toThrow();
  expect(h.service.find(h.documentId, h.secondInput.eventId)).toEqual(row);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});
it('keeps every observed and mutation lifecycle hash strict regardless of an opaque original expected version', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('completion rollback');
  const row = h.row();
  for (const status of [
    'prepared',
    'replaced',
    'in_doubt',
    'committed',
    'no_op',
    'conflict',
  ] as const) {
    expect(() => h.service.validate({ ...row, status, beforeHash: 'opaque-version' })).toThrow();
    expect(() => h.service.validate({ ...row, status, afterHash: 'opaque-version' })).toThrow();
  }
  expect(h.row()).toEqual(row);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('settles the original held manifest peer before propagating an undefined file-stat failure', async () => {
  const h = await fixture();
  const originalStat = fs.stat.bind(fs),
    originalRealpath = fs.realpath.bind(fs);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manifest = join(h.dir, '.dork', 'app.json');
  const statSpy = vi
    .spyOn(fs, 'stat')
    .mockImplementation((...args) =>
      String(args[0]) === h.path ? Promise.reject(undefined) : originalStat(...args)
    );
  const pathSpy = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    if (String(args[0]) === manifest) {
      entered();
      await held;
    }
    return originalRealpath(...args);
  });
  let settled = false;
  const observation = observeCheckboxSource(
    () =>
      readDocSourceDescriptor(
        { db: h.db, documents: h.rooms.canvasDocuments, roomRepos: h.roomRepos },
        h.documentId
      ),
    () => undefined
  ).then(
    () => {
      settled = true;
      throw new Error('Unexpected observation success');
    },
    (cause) => {
      settled = true;
      return { cause };
    }
  );
  try {
    await started;
    expect(settled).toBe(false);
    release();
    expect(await observation).toEqual({ cause: undefined });
  } finally {
    release();
    await Promise.allSettled([observation]);
    statSpy.mockRestore();
    pathSpy.mockRestore();
  }
});
it('preserves original non-file refusal before a settled manifest failure', async () => {
  const h = await fixture();
  const originalStat = fs.stat.bind(fs),
    originalRealpath = fs.realpath.bind(fs);
  const manifestFailure = new Error('Original manifest failure');
  const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
    const info = await originalStat(...args);
    if (String(args[0]) === h.path) info.isFile = () => false;
    return info;
  });
  const pathSpy = vi
    .spyOn(fs, 'realpath')
    .mockImplementation((...args) =>
      String(args[0]) === join(h.dir, '.dork', 'app.json')
        ? Promise.reject(manifestFailure)
        : originalRealpath(...args)
    );
  try {
    await expect(
      observeCheckboxSource(
        () =>
          readDocSourceDescriptor(
            { db: h.db, documents: h.rooms.canvasDocuments, roomRepos: h.roomRepos },
            h.documentId
          ),
        () => undefined
      )
    ).rejects.toThrow('WRITE_SOURCE_UNAVAILABLE');
  } finally {
    statSpy.mockRestore();
    pathSpy.mockRestore();
  }
});
