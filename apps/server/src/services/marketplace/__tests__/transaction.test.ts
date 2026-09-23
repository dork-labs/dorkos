/**
 * Tests for the file-scoped {@link runTransaction} engine.
 *
 * The engine is git-free: its transactional guarantee is entirely filesystem
 * scoped. `stage` builds package contents in an isolated temp dir; `activate`
 * moves them onto a `target`. When the target already exists it is moved aside
 * to a sibling backup before `activate`, so a failed activation restores the
 * previous installation byte-for-byte. There is no `git reset --hard` and thus
 * no `_internal.isGitRepo` mock. See ADR-0304.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTransaction, withInstallTargetLock, _internal } from '../transaction.js';
import { _internal as recoveryInternal, recoverInterruptedInstall } from '../install-recovery.js';
import { currentRecordOwner, formatRecordOwner, type RecordOwner } from '../lib/record-owner.js';
import { randomUUID } from 'node:crypto';

/** Returns true when `target` exists on disk (file or directory). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe('runTransaction (file-scoped)', () => {
  let scratch: string;
  const stagingDirsObserved: string[] = [];

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'transaction-test-scratch-'));
    stagingDirsObserved.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    for (const dir of stagingDirsObserved) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('runs stage then activate, cleans up staging, and returns the activate result', async () => {
    const target = path.join(scratch, 'install-root');
    const stage = vi.fn(async (staging: { path: string }) => {
      stagingDirsObserved.push(staging.path);
      await access(staging.path);
      await writeFile(path.join(staging.path, 'payload.txt'), 'hello', 'utf8');
    });
    const activate = vi.fn(async (staging: { path: string }) => {
      await access(staging.path);
      await mkdir(path.dirname(target), { recursive: true });
      const { atomicMove } = await import('../lib/atomic-move.js');
      await atomicMove(staging.path, target);
      return { ok: true, value: 42 };
    });

    const result = await runTransaction({ name: 'happy-path', target, stage, activate });

    expect(stage).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);

    // The staging dir is removed after success; the target holds the payload.
    expect(stagingDirsObserved).toHaveLength(1);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
    expect(await pathExists(target)).toBe(true);
    expect(await readFile(path.join(target, 'payload.txt'), 'utf8')).toBe('hello');
  });

  it('cleans up staging and rethrows when stage() throws, leaving target untouched', async () => {
    const target = path.join(scratch, 'stage-fail-target');
    // Pre-existing target that must NOT be touched when stage fails.
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'existing.txt'), 'preserve me', 'utf8');

    const stageError = new Error('stage failed');
    const activate = vi.fn();

    await expect(
      runTransaction({
        name: 'stage-throws',
        target,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
          await access(staging.path);
          throw stageError;
        },
        activate,
      })
    ).rejects.toBe(stageError);

    expect(activate).not.toHaveBeenCalled();
    // Staging removed.
    expect(stagingDirsObserved).toHaveLength(1);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
    // Target untouched: no backup was ever taken.
    expect(await readFile(path.join(target, 'existing.txt'), 'utf8')).toBe('preserve me');
    // No sibling backup was created.
    const siblings = await readdir(scratch);
    expect(siblings.some((s) => s.includes('.dorkos-bak-'))).toBe(false);
  });

  it('removes the partial target on a fresh-install activate failure', async () => {
    const target = path.join(scratch, 'fresh-install');
    const activateError = new Error('activate failed');

    await expect(
      runTransaction({
        name: 'fresh-activate-fail',
        target,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
        },
        activate: async () => {
          // Simulate a partial write before the throw.
          await mkdir(target, { recursive: true });
          await writeFile(path.join(target, 'partial.txt'), 'half-written', 'utf8');
          throw activateError;
        },
      })
    ).rejects.toBe(activateError);

    // The partial target is removed: no residue from a fresh install.
    expect(await pathExists(target)).toBe(false);
    expect(stagingDirsObserved).toHaveLength(1);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
  });

  it('restores the original target byte-for-byte on an overwrite-install activate failure', async () => {
    const target = path.join(scratch, 'overwrite-install');
    // Seed a pre-existing installation with distinctive content.
    await mkdir(path.join(target, 'nested'), { recursive: true });
    await writeFile(path.join(target, 'nested', 'original.txt'), 'ORIGINAL-CONTENT', 'utf8');
    await writeFile(path.join(target, 'top.txt'), 'top-original', 'utf8');

    const activateError = new Error('activate failed');

    await expect(
      runTransaction({
        name: 'overwrite-activate-fail',
        target,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
        },
        activate: async () => {
          // Simulate a partial overwrite: the engine has moved the original
          // aside, so the target is currently empty. Write garbage, then throw.
          await mkdir(target, { recursive: true });
          await writeFile(path.join(target, 'garbage.txt'), 'corrupt', 'utf8');
          throw activateError;
        },
      })
    ).rejects.toBe(activateError);

    // The original installation is restored exactly: garbage is gone.
    expect(await pathExists(target)).toBe(true);
    expect(await readFile(path.join(target, 'nested', 'original.txt'), 'utf8')).toBe(
      'ORIGINAL-CONTENT'
    );
    expect(await readFile(path.join(target, 'top.txt'), 'utf8')).toBe('top-original');
    expect(await pathExists(path.join(target, 'garbage.txt'))).toBe(false);
    // No leftover sibling backup.
    const siblings = await readdir(scratch);
    expect(siblings.filter((s) => s.includes('.dorkos-bak-'))).toEqual([]);
    // Staging removed.
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
  });

  it('deletes the target backup and leaves only the installed target on a successful overwrite', async () => {
    const target = path.join(scratch, 'overwrite-success');
    // Pre-existing installation.
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'old.txt'), 'old version', 'utf8');

    const result = await runTransaction({
      name: 'overwrite-success',
      target,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        await writeFile(path.join(staging.path, 'new.txt'), 'new version', 'utf8');
      },
      activate: async (staging) => {
        // The engine already moved the previous target aside, so the slot is
        // free, so the flow's activate is a plain atomicMove onto it.
        const { atomicMove } = await import('../lib/atomic-move.js');
        await atomicMove(staging.path, target);
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    // New version is present, old is gone.
    expect(await pathExists(path.join(target, 'new.txt'))).toBe(true);
    expect(await pathExists(path.join(target, 'old.txt'))).toBe(false);
    // No leftover backup sibling and no staging dir.
    const siblings = await readdir(scratch);
    expect(siblings.filter((s) => s.includes('.dorkos-bak-'))).toEqual([]);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
  });

  it('marks a fresh install with an absent record and leaves nothing behind once it commits', async () => {
    // A fresh install has no backup to restore, but a crash mid-activate still
    // needs undoing, so the transaction marks the target absent until commit.
    const target = path.join(scratch, 'fresh-success');
    const beginSpy = vi.spyOn(_internal, 'beginRecord');

    const result = await runTransaction({
      name: 'fresh-success',
      target,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
      },
      activate: async (staging) => {
        const { atomicMove } = await import('../lib/atomic-move.js');
        await mkdir(path.dirname(target), { recursive: true });
        await atomicMove(staging.path, target);
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    await expect(beginSpy.mock.results[0]?.value).resolves.toMatchObject({ kind: 'absent' });
    const siblings = await readdir(scratch);
    expect(siblings).toEqual(['fresh-success']);
  });

  it('rolls back and rethrows when the commit itself fails', async () => {
    // Until the commit lands, recovery would undo this install — so a failed
    // commit must undo it now rather than report a success recovery reverts.
    const target = path.join(scratch, 'commit-fails');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'old.txt'), 'old', 'utf8');
    vi.spyOn(_internal, 'commitRecord').mockRejectedValueOnce(new Error('rename refused'));

    await expect(
      runTransaction({
        name: 'commit-fails',
        target,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
          await writeFile(path.join(staging.path, 'new.txt'), 'new', 'utf8');
        },
        activate: async (staging) => {
          const { atomicMove } = await import('../lib/atomic-move.js');
          await atomicMove(staging.path, target);
        },
      })
    ).rejects.toThrow('rename refused');

    expect(await readFile(path.join(target, 'old.txt'), 'utf8')).toBe('old');
    expect(await readdir(scratch)).toEqual(['commit-fails']);
  });

  it('returns the activate result and logs a warning when success-path staging cleanup fails', async () => {
    const target = path.join(scratch, 'cleanup-fails');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cleanupSpy = vi
      .spyOn(_internal, 'cleanupStaging')
      .mockRejectedValueOnce(new Error('rm failed'));

    const result = await runTransaction({
      name: 'cleanup-fails',
      target,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
      },
      activate: async () => ({ ok: true, id: 'abc' }),
    });

    // A failed staging cleanup must NOT fail the install.
    expect(result.ok).toBe(true);
    expect(result.id).toBe('abc');
    expect(cleanupSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('never masks the original activate error when a rollback cleanup step fails', async () => {
    const target = path.join(scratch, 'restore-fails');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'orig.txt'), 'orig', 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Force the partial-target removal to throw during rollback; the original
    // activate error must still be the thrown error.
    const removeSpy = vi
      .spyOn(recoveryInternal, 'removePath')
      .mockRejectedValueOnce(new Error('remove exploded'));

    const activateError = new Error('activate failed');

    await expect(
      runTransaction({
        name: 'restore-fails',
        target,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
        },
        activate: async () => {
          throw activateError;
        },
      })
    ).rejects.toBe(activateError);

    expect(removeSpy).toHaveBeenCalled();
    // The cleanup failure was logged, not thrown.
    expect(warnSpy).toHaveBeenCalled();
    // And the backup is still on disk for the next recovery, which restores it.
    await recoverInterruptedInstall(target);
    expect(await readFile(path.join(target, 'orig.txt'), 'utf8')).toBe('orig');
  });

  it('uses the staging prefix dorkos-install-<name>- under the OS temp dir', async () => {
    const target = path.join(scratch, 'prefix-check');
    const result = await runTransaction({
      name: 'prefix-check',
      target,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        const base = path.basename(staging.path);
        expect(base.startsWith('dorkos-install-prefix-check-')).toBe(true);
        expect(staging.path.startsWith(tmpdir())).toBe(true);
      },
      activate: async () => ({ ok: true }),
    });

    expect(result.ok).toBe(true);
  });
});

/**
 * A crash is a transaction that stops at some step and never runs another
 * line. Each test parks a real transaction at one step (a promise that never
 * settles, so no cleanup or rollback runs), then runs recovery the way the
 * next server start would and checks the person has a working install.
 */
describe('runTransaction crash windows (DOR-2273)', () => {
  let scratch: string;
  const parked: string[] = [];

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'transaction-crash-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    for (const dir of parked.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A promise that never settles: the process "died" here. */
  const never = (): Promise<never> => new Promise<never>(() => undefined);

  /** Seed an installed v1 at `target`. */
  async function installV1(target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'version.txt'), 'v1', 'utf8');
  }

  /** Which version stands at `target`. */
  async function versionAt(target: string): Promise<string> {
    return readFile(path.join(target, 'version.txt'), 'utf8');
  }

  /**
   * Start a v2 install of `target` and resolve once it has reached `crashAt`,
   * where it stops for good. The transaction itself is left pending.
   */
  async function crashInstall(
    target: string,
    crashAt: 'before-activate' | 'mid-activate' | 'before-commit' | 'after-commit' | 'mid-rollback'
  ): Promise<void> {
    let reached!: () => void;
    const reachedCrash = new Promise<void>((resolve) => (reached = resolve));
    const crash = (): Promise<never> => {
      reached();
      return never();
    };

    if (crashAt === 'before-commit')
      vi.spyOn(_internal, 'commitRecord').mockImplementationOnce(crash);
    if (crashAt === 'after-commit')
      vi.spyOn(recoveryInternal, 'removePath').mockImplementationOnce(crash);
    if (crashAt === 'mid-rollback')
      vi.spyOn(recoveryInternal, 'move').mockImplementationOnce(crash);

    void runTransaction({
      name: `crash-${crashAt}`,
      target,
      stage: async (staging) => {
        parked.push(staging.path);
        await writeFile(path.join(staging.path, 'version.txt'), 'v2', 'utf8');
      },
      activate: async (staging) => {
        if (crashAt === 'before-activate') return crash();
        // A multi-step activate: the files land, then something else runs
        // (an agent's workspace scaffold, extension enabling).
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, 'version.txt'), 'v2-half', 'utf8');
        if (crashAt === 'mid-activate') return crash();
        if (crashAt === 'mid-rollback') throw new Error('activate failed');
        await writeFile(path.join(target, 'version.txt'), 'v2', 'utf8');
        void staging;
      },
    }).catch(() => undefined);

    await reachedCrash;
  }

  it('restores v1 after a crash between moving it aside and activating', async () => {
    const target = path.join(scratch, 'flow');
    await installV1(target);
    await crashInstall(target, 'before-activate');
    expect(await pathExists(target)).toBe(false); // the person has nothing

    await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await readdir(scratch)).toEqual(['flow']);
  });

  it('restores v1 after a crash half-way through activation', async () => {
    const target = path.join(scratch, 'flow');
    await installV1(target);
    await crashInstall(target, 'mid-activate');
    expect(await versionAt(target)).toBe('v2-half');

    await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await readdir(scratch)).toEqual(['flow']);
  });

  it('restores v1 after a crash between activation and commit', async () => {
    // v2 looks finished, but nothing proves it was: uncommitted is undone.
    const target = path.join(scratch, 'flow');
    await installV1(target);
    await crashInstall(target, 'before-commit');
    expect(await versionAt(target)).toBe('v2');

    await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await readdir(scratch)).toEqual(['flow']);
  });

  it('keeps v2 and deletes v1 after a crash between commit and cleanup', async () => {
    const target = path.join(scratch, 'flow');
    await installV1(target);
    await crashInstall(target, 'after-commit');
    expect((await readdir(scratch)).some((n) => n.endsWith('.committed'))).toBe(true);

    await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v2');
    expect(await readdir(scratch)).toEqual(['flow']);
  });

  it('restores v1 after a crash half-way through a rollback', async () => {
    // The failed install's partial target is gone and v1 is not back yet.
    const target = path.join(scratch, 'flow');
    await installV1(target);
    await crashInstall(target, 'mid-rollback');
    expect(await pathExists(target)).toBe(false);

    await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await readdir(scratch)).toEqual(['flow']);
  });

  it('removes a half-written fresh install after a crash', async () => {
    const target = path.join(scratch, 'flow');
    await crashInstall(target, 'mid-activate');
    expect(await versionAt(target)).toBe('v2-half');

    await recoverInterruptedInstall(target);

    expect(await readdir(scratch)).toEqual([]);
  });

  it('settles a crash-left record before the next install of that target', async () => {
    // "Next operation on that target": without this, the new install would
    // move the half-written target aside as its own backup and v1 would
    // linger, only to be restored over v2 later.
    const target = path.join(scratch, 'flow');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'version.txt'), 'v2-half', 'utf8');
    const backup = path.join(
      scratch,
      `flow.dorkos-bak-${Date.now()}-${formatRecordOwner(currentRecordOwner())}-${randomUUID()}`
    );
    await installV1(backup);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let seenAtActivate = '';

    await runTransaction({
      name: 'after-crash',
      target,
      stage: async (staging) => {
        parked.push(staging.path);
        await writeFile(path.join(staging.path, 'version.txt'), 'v3', 'utf8');
      },
      activate: async (staging) => {
        const siblings = await readdir(scratch);
        const current = siblings.find((n) => n !== 'flow' && !n.endsWith('.absent'))!;
        seenAtActivate = await versionAt(path.join(scratch, current));
        const { atomicMove } = await import('../lib/atomic-move.js');
        await atomicMove(staging.path, target);
      },
    });

    // The install moved aside the restored v1, not the half-written v2.
    expect(seenAtActivate).toBe('v1');
    expect(await versionAt(target)).toBe('v3');
    expect(await readdir(scratch)).toEqual(['flow']);
  });

  it('refuses to start while another running process owns a record for the target', async () => {
    // Two servers on one project: moving the other one's half-activated
    // target aside would destroy its install.
    const { spawn } = await import('node:child_process');
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise((resolve) => other.once('spawn', resolve));
    try {
      const target = path.join(scratch, 'flow');
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'version.txt'), 'v2-theirs', 'utf8');
      const { _internal: ownerInternal } = await import('../lib/record-owner.js');
      const owner: RecordOwner = {
        ...currentRecordOwner(),
        pid: other.pid!,
        startedAt: ownerInternal.readProcessStartSeconds(other.pid!) ?? 0,
      };
      await installV1(
        path.join(
          scratch,
          `flow.dorkos-bak-${Date.now()}-${formatRecordOwner(owner)}-${randomUUID()}`
        )
      );
      const activate = vi.fn();

      await expect(
        runTransaction({ name: 'blocked', target, stage: async () => undefined, activate })
      ).rejects.toThrow(/Another DorkOS app may be changing/);

      expect(activate).not.toHaveBeenCalled();
      expect(await versionAt(target)).toBe('v2-theirs');
      expect(await readdir(scratch)).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => {
        other.once('exit', () => resolve());
        other.kill();
      });
    }
  });
});

describe('withInstallTargetLock (re-entrancy)', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'target-lock-reentrancy-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  });

  it('runs a nested take of a target this context already holds, inline', async () => {
    // What `MarketplaceInstaller.update()` needs: it holds the install root
    // across an uninstall and an install that each take the lock for
    // themselves. `withFileLock` throws on re-entry — the right default for a
    // file writer, and a hard stop for a composite operation — so this asks for
    // the target twice and expects the inner one to simply run.
    const target = path.join(scratch, 'plugins', 'nested-package');
    const order: string[] = [];

    const result = await withInstallTargetLock(target, async () => {
      order.push('outer-enter');
      const inner = await withInstallTargetLock(target, async () => {
        order.push('inner');
        return 'inner-result';
      });
      order.push('outer-exit');
      return inner;
    });

    expect(result).toBe('inner-result');
    expect(order).toEqual(['outer-enter', 'inner', 'outer-exit']);
  });

  it('re-enters on the canonical target, not on the spelling the nested call used', async () => {
    // The outer hold is keyed on the realpath, so a nested call that spells the
    // same directory through a symlink has to resolve to the same key — or it
    // would queue behind its own caller and never return.
    const realProject = path.join(scratch, 'real-project');
    const target = path.join(realProject, '.dork', 'plugins', 'nested-package');
    await mkdir(target, { recursive: true });
    const linkedProject = path.join(scratch, 'linked-project');
    await symlink(realProject, linkedProject, 'dir');
    const linkedTarget = path.join(linkedProject, '.dork', 'plugins', 'nested-package');

    await expect(
      withInstallTargetLock(target, () =>
        withInstallTargetLock(linkedTarget, async () => 'reached')
      )
    ).resolves.toBe('reached');
  });

  it('still makes a second holder wait, because re-entry is scoped to one context', async () => {
    // Re-entrancy must not be a hole in the mutual exclusion: only the context
    // that already holds the target skips the queue.
    const target = path.join(scratch, 'plugins', 'contended-package');
    const holderEntered = deferredVoid();
    const releaseHolder = deferredVoid();
    let secondEntered = false;

    const holder = withInstallTargetLock(target, async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
      // A nested take from inside the hold runs inline even while another
      // caller is queued on this same target.
      return withInstallTargetLock(target, async () => 'holder');
    });
    await holderEntered.promise;

    const second = withInstallTargetLock(target, async () => {
      secondEntered = true;
      return 'second';
    });

    // Three whole unrelated critical sections run while the holder is parked —
    // strictly more work than the `second` call has left before it would enter,
    // so this bounds the wait on real steps instead of on a timer.
    for (const probe of ['probe-a', 'probe-b', 'probe-c']) {
      await withInstallTargetLock(path.join(scratch, 'plugins', 'unrelated'), async () => probe);
    }
    expect(secondEntered).toBe(false);

    releaseHolder.resolve();
    await expect(Promise.all([holder, second])).resolves.toEqual(['holder', 'second']);
  });
});

/** A promise plus the handle to settle it from elsewhere in the test. */
function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Sanity check that mkdtemp/rm round-trip in the test environment works
// (so a green test run definitively means runTransaction is correct).
describe('test harness sanity', () => {
  it('mkdtemp + rm round-trip works', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'transaction-sanity-'));
    await access(dir);
    await rm(dir, { recursive: true, force: true });
    await expect(access(dir)).rejects.toThrow();
  });
});
