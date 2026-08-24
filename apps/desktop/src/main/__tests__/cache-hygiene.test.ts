import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { clearHttpCacheOnVersionChange, CLEAR_CACHE_TIMEOUT_MS } from '../cache-hygiene';
import { app, session, resetElectronMock } from './electron-mock';
import log, { resetLogMock } from './electron-log-mock';

/**
 * Real files on a throwaway userData dir rather than a mocked `node:fs`: the
 * behavior under test is "what the *next* launch reads", so the write and the
 * read have to be the same round trip. The dir deliberately does not exist at
 * the start of each test — first launch on a fresh machine is the case that
 * has to work.
 */
describe('clearHttpCacheOnVersionChange', () => {
  const CURRENT_VERSION = '1.4.0';
  let base: string;
  let userData: string;
  let versionFile: string;

  /** What the version file holds, or `null` when it was never written. */
  function recordedVersion(): string | null {
    if (!existsSync(versionFile)) return null;
    return (JSON.parse(readFileSync(versionFile, 'utf-8')) as { version?: string }).version ?? null;
  }

  /** Pretend a previous launch left `contents` behind. */
  function seedVersionFile(contents: string): void {
    mkdirSync(userData, { recursive: true });
    writeFileSync(versionFile, contents);
  }

  beforeEach(() => {
    resetElectronMock();
    resetLogMock();
    base = mkdtempSync(join(tmpdir(), 'dorkos-cache-hygiene-'));
    userData = join(base, 'userData');
    versionFile = join(userData, 'last-run-version.json');
    app.getPath = vi.fn(() => userData);
    app.getVersion = vi.fn(() => CURRENT_VERSION);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  it('clears the cache and records the version on a first launch', async () => {
    await clearHttpCacheOnVersionChange();

    expect(session.defaultSession.clearCache).toHaveBeenCalledTimes(1);
    expect(recordedVersion()).toBe(CURRENT_VERSION);
  });

  it('does not clear the cache when relaunching the same version', async () => {
    seedVersionFile(JSON.stringify({ version: CURRENT_VERSION }));

    await clearHttpCacheOnVersionChange();

    expect(session.defaultSession.clearCache).not.toHaveBeenCalled();
  });

  it('clears the cache when the version changed since the last launch', async () => {
    seedVersionFile(JSON.stringify({ version: '1.3.0' }));

    await clearHttpCacheOnVersionChange();

    expect(session.defaultSession.clearCache).toHaveBeenCalledTimes(1);
    expect(recordedVersion()).toBe(CURRENT_VERSION);
  });

  it('treats an unreadable version file as no record and clears', async () => {
    seedVersionFile('{ truncated');

    await clearHttpCacheOnVersionChange();

    expect(session.defaultSession.clearCache).toHaveBeenCalledTimes(1);
    expect(recordedVersion()).toBe(CURRENT_VERSION);
  });

  it('gives up on a clear that never settles, so the first window is never held hostage', async () => {
    vi.useFakeTimers();
    // A promise that never settles — a wedged network service or a locked
    // cache dir. The caller holds window creation on this, so resolving at the
    // deadline is the difference between a slow launch and no window at all.
    session.defaultSession.clearCache = vi.fn(() => new Promise<void>(() => {}));

    const pending = clearHttpCacheOnVersionChange();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(CLEAR_CACHE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(recordedVersion()).toBeNull();
  });

  it('swallows and logs a clearCache failure, leaving the version unrecorded so the next launch retries', async () => {
    session.defaultSession.clearCache = vi.fn(() => Promise.reject(new Error('cache locked')));

    await expect(clearHttpCacheOnVersionChange()).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(recordedVersion()).toBeNull();
  });
});
