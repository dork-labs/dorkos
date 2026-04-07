/**
 * Tests for the {@link atomicMove} helper. Covers three paths:
 *
 * 1. Happy path — same-filesystem rename succeeds with no fallback.
 * 2. EXDEV fallback — `fs.rename` throws `EXDEV`, the helper recovers
 *    via `cp` + `rm` so the resulting tree is observably identical.
 * 3. Non-EXDEV error — any other errno rethrows without touching the
 *    destination (we must not silently convert a permission error into
 *    a partial copy).
 *
 * The happy path exercises the real filesystem (tmp dir) because
 * mocking `fs.rename` wholesale loses coverage of the actual syscall
 * wiring. The EXDEV and error-propagation cases mock `rename` because
 * we cannot reliably simulate a cross-device rename on developer
 * machines or CI runners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hoisted mock for `fs.rename` — the `renameMock` closure lets each test
// choose whether the real syscall runs (`undefined`) or an injected error
// is thrown. Other exports pass through untouched so `cp`, `rm`, and
// friends still hit the real filesystem.
const { renameMock } = vi.hoisted(() => {
  return { renameMock: vi.fn() };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs/promises');
  return {
    ...actual,
    rename: (source: string, dest: string) => {
      const override = renameMock(source, dest);
      if (override instanceof Error) throw override;
      return actual.rename(source, dest);
    },
  };
});

import { atomicMove, isCrossDeviceError } from '../atomic-move.js';

/** Returns true if `target` exists on disk (file or directory). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('atomicMove', () => {
  const cleanupRoots: string[] = [];

  beforeEach(() => {
    // Default: pass through to the real `rename`.
    renameMock.mockReset();
    renameMock.mockReturnValue(undefined);
  });

  afterEach(async () => {
    while (cleanupRoots.length > 0) {
      const dir = cleanupRoots.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('renames a directory on the same filesystem (happy path)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dorkos-atomic-move-'));
    cleanupRoots.push(root);

    const source = path.join(root, 'source');
    const dest = path.join(root, 'dest');
    await mkdir(path.join(source, 'nested'), { recursive: true });
    await writeFile(path.join(source, 'top.txt'), 'top', 'utf8');
    await writeFile(path.join(source, 'nested', 'inner.txt'), 'inner', 'utf8');

    await atomicMove(source, dest);

    expect(await pathExists(source)).toBe(false);
    expect(await pathExists(dest)).toBe(true);
    expect(await readFile(path.join(dest, 'top.txt'), 'utf8')).toBe('top');
    expect(await readFile(path.join(dest, 'nested', 'inner.txt'), 'utf8')).toBe('inner');
  });

  it('falls back to cp + rm when rename throws EXDEV', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dorkos-atomic-move-exdev-'));
    cleanupRoots.push(root);

    const source = path.join(root, 'source');
    const dest = path.join(root, 'dest');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'payload.txt'), 'payload', 'utf8');

    const exdev: NodeJS.ErrnoException = Object.assign(new Error('simulated EXDEV'), {
      code: 'EXDEV',
    });
    renameMock.mockReturnValueOnce(exdev);

    await atomicMove(source, dest);

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(await pathExists(source)).toBe(false);
    expect(await pathExists(dest)).toBe(true);
    expect(await readFile(path.join(dest, 'payload.txt'), 'utf8')).toBe('payload');
  });

  it('rethrows non-EXDEV errors without copying', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dorkos-atomic-move-eacces-'));
    cleanupRoots.push(root);

    const source = path.join(root, 'source');
    const dest = path.join(root, 'dest');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'payload.txt'), 'payload', 'utf8');

    const eacces: NodeJS.ErrnoException = Object.assign(new Error('simulated EACCES'), {
      code: 'EACCES',
    });
    renameMock.mockReturnValueOnce(eacces);

    await expect(atomicMove(source, dest)).rejects.toThrow('simulated EACCES');

    // Source must remain untouched — we never attempted the copy fallback.
    expect(await pathExists(source)).toBe(true);
    expect(await pathExists(dest)).toBe(false);
  });

  describe('isCrossDeviceError', () => {
    it('returns true for an object with code === "EXDEV"', () => {
      expect(isCrossDeviceError({ code: 'EXDEV' })).toBe(true);
    });

    it('returns false for other error codes', () => {
      expect(isCrossDeviceError({ code: 'EACCES' })).toBe(false);
      expect(isCrossDeviceError({ code: 'ENOENT' })).toBe(false);
    });

    it('returns false for non-object values', () => {
      expect(isCrossDeviceError(null)).toBe(false);
      expect(isCrossDeviceError(undefined)).toBe(false);
      expect(isCrossDeviceError('EXDEV')).toBe(false);
      expect(isCrossDeviceError(42)).toBe(false);
    });

    it('returns false for an object without a code property', () => {
      expect(isCrossDeviceError(new Error('no code'))).toBe(false);
    });
  });
});
