import { mkdtemp, mkdir, writeFile, readFile, link, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallationMutations, type OwnedMutation } from '../installation-mutations.js';
import {
  filesystemMutationRootProbe,
  MutationRefusal,
  type TreeRootProbe,
} from '../mutation-roots.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'installation-mutations-'));
  temporary.push(root);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  await Promise.all([mkdir(a), mkdir(b)]);
  return { root, a, b, scheduler: new InstallationMutations(filesystemMutationRootProbe) };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('InstallationMutations', () => {
  it.each(['files-first', 'opaque-first'])(
    'excludes cross-root hardlink effects in %s order',
    async (order) => {
      const { a, b } = await fixture();
      // Real static root identities with immediate scheduling remove filesystem timing from the
      // exclusion oracle; fresh filesystem retarget controls below exercise the real probe.
      const identities = new Map(
        await Promise.all(
          [a, b].map(
            async (directory) =>
              [directory, await filesystemMutationRootProbe.resolve({ directory })] as const
          )
        )
      );
      const scheduler = new InstallationMutations({
        async resolve(root) {
          return identities.get(root.directory)!;
        },
      });
      const left = path.join(a, 'left');
      const right = path.join(b, 'right');
      await writeFile(left, 'original');
      await link(left, right);
      const entered = deferred();
      const release = deferred();
      const nextEntered = deferred();
      const firstMode = order === 'files-first' ? 'files' : 'opaque';
      const first = scheduler.withMutation(firstMode, [{ directory: a }], async () => {
        entered.resolve();
        await release.promise;
        expect(await readFile(left, 'utf8')).toBe('original');
      });
      await entered.promise;
      const second = scheduler.withMutation(
        firstMode === 'files' ? 'opaque' : 'files',
        [{ directory: b }],
        async () => {
          nextEntered.resolve();
          await writeFile(right, 'changed');
        }
      );
      let started = false;
      void nextEntered.promise.then(() => {
        started = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(started).toBe(false);
      release.resolve();
      await Promise.all([first, second]);
      expect(await readFile(left, 'utf8')).toBe('changed');
      await scheduler.stop();
    }
  );

  it('runs unrelated files concurrently and honors the global FIFO opaque barrier', async () => {
    const { a, b, scheduler } = await fixture();
    const firstEntered = deferred();
    const secondEntered = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = scheduler.withMutation('files', [{ directory: a }], async () => {
      firstEntered.resolve();
      await release.promise;
      order.push('a');
    });
    await firstEntered.promise;
    const second = scheduler.withMutation('files', [{ directory: b }], async () => {
      secondEntered.resolve();
      await release.promise;
      order.push('b');
    });
    await secondEntered.promise;
    const opaque = scheduler.withMutation('opaque', [{ directory: b }], async () => {
      order.push('opaque');
    });
    const later = scheduler.withMutation('files', [{ directory: a }], async () => {
      order.push('later');
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([first, second, opaque, later]);
    expect(order.slice(2)).toEqual(['opaque', 'later']);
  });

  it('holds exclusive ownership across rollback and publication, not just the first effect', async () => {
    const { a, b, scheduler } = await fixture();
    const file = path.join(a, 'file');
    await writeFile(file, 'before');
    const effected = deferred();
    const rollback = deferred();
    const published = deferred();
    const finish = deferred();
    const operation = scheduler.withMutation('opaque', [{ directory: a }], async () => {
      await writeFile(file, 'effect');
      effected.resolve();
      await rollback.promise;
      await writeFile(file, 'before');
      published.resolve();
      await finish.promise;
    });
    await effected.promise;
    let slipped = false;
    const waiter = scheduler.withMutation('files', [{ directory: b }], async () => {
      slipped = true;
    });
    rollback.resolve();
    await published.promise;
    expect(slipped).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('before');
    finish.resolve();
    await Promise.all([operation, waiter]);
    expect(slipped).toBe(true);
  });

  it('refuses a queued retargeted root before its callback and retires capabilities', async () => {
    const { a, b, scheduler } = await fixture();
    const entered = deferred();
    const release = deferred();
    let retired!: OwnedMutation;
    const blocker = scheduler.withMutation('opaque', [{ directory: b }], async (owned) => {
      retired = owned;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let called = false;
    const queued = scheduler.withMutation('files', [{ directory: a }], async () => {
      called = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    await rename(a, `${a}-old`);
    await mkdir(a);
    release.resolve();
    await blocker;
    await expect(queued).rejects.toMatchObject({ code: 'root-changed' });
    expect(called).toBe(false);
    expect(() => retired.assertActive()).toThrow(MutationRefusal);
    await expect(retired.assertCurrentRoots()).rejects.toMatchObject({ code: 'inactive' });
  });

  it('rejects nesting/upgrades and callback stop while allowing unrelated ownership', async () => {
    const { a, scheduler } = await fixture();
    await scheduler.withMutation('files', [{ directory: a }], async () => {
      await expect(
        scheduler.withMutation('opaque', [{ directory: a }], async () => {})
      ).rejects.toMatchObject({ code: 'reentrant' });
      await expect(scheduler.stop()).rejects.toMatchObject({ code: 'reentrant' });
    });
    await scheduler.withMutation('opaque', [{ directory: a }], async () => {});
  });

  it('reserves capacity before any probe, drains all failures including an undefined first cause', async () => {
    const hold = deferred();
    const entered = deferred();
    let probes = 0;
    const probe: TreeRootProbe = {
      async resolve() {
        probes++;
        entered.resolve();
        await hold.promise;
        throw undefined;
      },
    };
    const scheduler = new InstallationMutations(probe);
    const jobs = Array.from({ length: 1024 }, () =>
      scheduler.withMutation('files', [{ directory: '/real-host-root' }], async () => {})
    );
    const observed = Promise.allSettled(jobs);
    await expect(
      scheduler.withMutation('files', [{ directory: '/extra' }], async () => {})
    ).rejects.toMatchObject({ code: 'queue-limit' });
    await entered.promise;
    expect(probes).toBe(1024);
    let stopped = false;
    const stop = scheduler.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(stopped).toBe(false);
    hold.resolve();
    await stop;
    expect(
      (await observed).every((job) => job.status === 'rejected' && job.reason === undefined)
    ).toBe(true);
    await expect(
      scheduler.withMutation('files', [{ directory: '/later' }], async () => {})
    ).rejects.toMatchObject({ code: 'closing' });
  });

  it('settles every launched root probe before rejecting a synchronous first failure', async () => {
    const held = deferred();
    const launched = deferred();
    const sentinel = new Error('first');
    let secondSettled = false;
    const scheduler = new InstallationMutations({
      resolve(root) {
        if (root.directory === '/one') throw sentinel;
        launched.resolve();
        return held.promise.then(() => {
          secondSettled = true;
          throw new Error('later');
        });
      },
    });
    let finished = false;
    const operation = scheduler
      .withMutation('opaque', [{ directory: '/one' }, { directory: '/two' }], async () => {})
      .catch((error: unknown) => {
        finished = true;
        throw error;
      });
    const observed = expect(operation).rejects.toBe(sentinel);
    await launched.promise;
    expect(finished).toBe(false);
    held.resolve();
    await observed;
    expect(secondSettled).toBe(true);
  });

  it('closes queued admission and shares one drain while an actual owner is still held', async () => {
    const { a, b, scheduler } = await fixture();
    const entered = deferred();
    const release = deferred();
    const first = scheduler.withMutation('files', [{ directory: a }], async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let called = false;
    const queued = scheduler.withMutation('opaque', [{ directory: b }], async () => {
      called = true;
    });
    const observed = expect(queued).rejects.toMatchObject({ code: 'closing' });
    const firstStop = scheduler.stop();
    expect(scheduler.stop()).toBe(firstStop);
    let drained = false;
    void firstStop.then(() => {
      drained = true;
    });
    await observed;
    expect(called).toBe(false);
    expect(drained).toBe(false);
    release.resolve();
    await Promise.all([first, firstStop]);
    expect(drained).toBe(true);
  });

  it('admits more than sixteen files as one opaque operation but refuses seventeen actual roots', async () => {
    const { a, scheduler } = await fixture();
    let effects = 0;
    await scheduler.withMutation('opaque', [{ directory: a }], async () => {
      effects++;
      await promisify(execFile)('git', ['init', '-q', a]);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          writeFile(path.join(a, `file-${index}`), 'git-like-result')
        )
      );
      await promisify(execFile)('git', ['-C', a, 'add', '.']);
      await promisify(execFile)('git', [
        '-C',
        a,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ]);
    });
    await expect(
      scheduler.withMutation(
        'opaque',
        Array.from({ length: 17 }, () => ({ directory: a })),
        async () => {
          effects++;
        }
      )
    ).rejects.toMatchObject({ code: 'root-limit' });
    expect(effects).toBe(1);
  });
});
