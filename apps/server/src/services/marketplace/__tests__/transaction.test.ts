import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTransaction, _internal } from '../transaction.js';

describe('runTransaction', () => {
  let stagingDirsObserved: string[];

  beforeEach(() => {
    stagingDirsObserved = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Best-effort cleanup of any staging dirs that leaked through bugs
    for (const dir of stagingDirsObserved) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('runs stage then activate, cleans up staging, and returns activate result', async () => {
    const stage = vi.fn(async (staging: { path: string }) => {
      stagingDirsObserved.push(staging.path);
      // Confirm the staging dir exists during stage()
      await access(staging.path);
    });
    const activate = vi.fn(async (staging: { path: string }) => {
      // Confirm the staging dir still exists during activate()
      await access(staging.path);
      return { ok: true, value: 42 };
    });

    const result = await runTransaction({
      name: 'happy-path',
      rollbackBranch: false,
      stage,
      activate,
    });

    expect(stage).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(result.rollbackBranch).toBeUndefined();

    // Staging dir should be removed after success
    expect(stagingDirsObserved).toHaveLength(1);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
  });

  it('cleans up staging and rethrows when stage() throws', async () => {
    const stageError = new Error('stage failed');
    const activate = vi.fn();

    await expect(
      runTransaction({
        name: 'stage-throws',
        rollbackBranch: false,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
          await access(staging.path);
          throw stageError;
        },
        activate,
      })
    ).rejects.toBe(stageError);

    expect(activate).not.toHaveBeenCalled();
    expect(stagingDirsObserved).toHaveLength(1);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
  });

  it('cleans up staging and rethrows when activate() throws', async () => {
    const activateError = new Error('activate failed');

    await expect(
      runTransaction({
        name: 'activate-throws',
        rollbackBranch: false,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
        },
        activate: async () => {
          throw activateError;
        },
      })
    ).rejects.toBe(activateError);

    expect(stagingDirsObserved).toHaveLength(1);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
  });

  it('creates a backup branch and rolls back when activate fails in a git repo', async () => {
    const createSpy = vi
      .spyOn(_internal, 'createBackupBranch')
      .mockResolvedValue('dorkos-rollback-test-branch');
    const rollbackSpy = vi.spyOn(_internal, 'rollbackToBranch').mockResolvedValue(undefined);
    const isGitRepoSpy = vi.spyOn(_internal, 'isGitRepo').mockResolvedValue(true);

    const activateError = new Error('activate failed');

    await expect(
      runTransaction({
        name: 'rollback-git',
        rollbackBranch: true,
        stage: async (staging) => {
          stagingDirsObserved.push(staging.path);
        },
        activate: async () => {
          throw activateError;
        },
      })
    ).rejects.toBe(activateError);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(rollbackSpy).toHaveBeenCalledWith('dorkos-rollback-test-branch');
    expect(isGitRepoSpy).toHaveBeenCalled();

    // Staging cleaned up regardless of rollback
    expect(stagingDirsObserved).toHaveLength(1);
    await expect(access(stagingDirsObserved[0])).rejects.toThrow();
  });

  it('does not create or roll back a branch when CWD is not a git repo', async () => {
    const isGitRepoSpy = vi.spyOn(_internal, 'isGitRepo').mockResolvedValue(false);
    const createSpy = vi.spyOn(_internal, 'createBackupBranch');
    const rollbackSpy = vi.spyOn(_internal, 'rollbackToBranch');

    const result = await runTransaction({
      name: 'no-git',
      rollbackBranch: true,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
      },
      activate: async () => ({ ok: true }),
    });

    expect(isGitRepoSpy).toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.rollbackBranch).toBeUndefined();
  });

  it('returns activate result and logs warning when success-path cleanup fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Make fs.rm fail by activating with a path that we replace with a sentinel.
    // Easiest: spy on the cleanup helper. We expose it via _internal as `cleanupStaging`.
    const cleanupSpy = vi
      .spyOn(_internal, 'cleanupStaging')
      .mockRejectedValueOnce(new Error('rm failed'));

    const result = await runTransaction({
      name: 'cleanup-fails',
      rollbackBranch: false,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
      },
      activate: async () => ({ ok: true, id: 'abc' }),
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBe('abc');
    expect(cleanupSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    // Real cleanup never ran — sweep the leaked dir manually
    for (const dir of stagingDirsObserved) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('uses the staging prefix dorkos-install-<name>- under the OS temp dir', async () => {
    const result = await runTransaction({
      name: 'prefix-check',
      rollbackBranch: false,
      stage: async (staging) => {
        stagingDirsObserved.push(staging.path);
        const base = staging.path.split('/').pop() ?? '';
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
    const dir = await mkdtemp(join(tmpdir(), 'transaction-sanity-'));
    await access(dir);
    await rm(dir, { recursive: true, force: true });
    await expect(access(dir)).rejects.toThrow();
  });
});
