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
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTransaction, _internal } from '../transaction.js';

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

  it('does not create a backup when the target does not exist (fresh install success)', async () => {
    const target = path.join(scratch, 'fresh-success');
    const moveAsideSpy = vi.spyOn(_internal, 'moveTargetAside');

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
    // moveTargetAside runs but returns undefined (no backup) for a fresh install.
    expect(moveAsideSpy).toHaveBeenCalledWith(target);
    await expect(moveAsideSpy.mock.results[0]?.value).resolves.toBeUndefined();
    const siblings = await readdir(scratch);
    expect(siblings.some((s) => s.includes('.dorkos-bak-'))).toBe(false);
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
      .spyOn(_internal, 'removePath')
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
