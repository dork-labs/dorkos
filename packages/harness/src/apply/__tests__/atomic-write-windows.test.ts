/**
 * The Windows-only boundary around atomic rename retries.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATOMIC_TMP_SUFFIX,
  WINDOWS_RENAME_RETRY_DELAYS_MS,
  writeFileAtomic,
} from '../atomic-write.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const { renameSync: realRenameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
const realPlatform = process.platform;
let dir = '';

beforeEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(realRenameSync);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  dir = mkdtempSync(join(tmpdir(), 'atomic-windows-'));
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** A filesystem error carrying the code Node exposes. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: measured rename failure`), { code, syscall: 'rename' });
}

describe('the Windows atomic-rename retry', () => {
  it('lands the same temp file after transient EPERM responses', () => {
    // Seven failures outlive the original six-retry/63 ms policy that the real
    // polling-reader run exhausted on Windows.
    for (let attempt = 0; attempt < 7; attempt++) {
      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw errno('EPERM');
      });
    }
    const target = join(dir, 'hooks.json');

    writeFileAtomic(target, 'complete\n');

    expect(readFileSync(target, 'utf8')).toBe('complete\n');
    expect(renameSync).toHaveBeenCalledTimes(8);
    expect(readdirSync(dir)).toEqual(['hooks.json']);
  });

  it('stops after the finite Windows EPERM schedule and removes only its temp', () => {
    for (let attempt = 0; attempt <= WINDOWS_RENAME_RETRY_DELAYS_MS.length; attempt++) {
      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw errno('EPERM');
      });
    }
    const target = join(dir, 'hooks.json');
    writeFileSync(target, 'old\n');

    expect(() => writeFileAtomic(target, 'complete\n')).toThrow(/EPERM/);

    expect(renameSync).toHaveBeenCalledTimes(WINDOWS_RENAME_RETRY_DELAYS_MS.length + 1);
    expect(readFileSync(target, 'utf8')).toBe('old\n');
    expect(readdirSync(dir).filter((name) => name.endsWith(ATOMIC_TMP_SUFFIX))).toEqual([]);
  });

  it('does not retry a different Windows rename failure', () => {
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw errno('EACCES');
    });

    expect(() => writeFileAtomic(join(dir, 'hooks.json'), 'complete\n')).toThrow(/EACCES/);
    expect(renameSync).toHaveBeenCalledTimes(1);
  });

  it('does not apply the Windows retry policy on another platform', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw errno('EPERM');
    });

    expect(() => writeFileAtomic(join(dir, 'hooks.json'), 'complete\n')).toThrow(/EPERM/);
    expect(renameSync).toHaveBeenCalledTimes(1);
  });
});
