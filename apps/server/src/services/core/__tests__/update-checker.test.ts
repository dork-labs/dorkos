import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock version module — must be before importing update-checker
vi.mock('../../../lib/version.js', () => ({
  IS_DEV_BUILD: false,
  SERVER_VERSION: '1.0.0',
}));

const role = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' | 'agent-computer' }));
vi.mock('../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const envMock = vi.hoisted(() => ({
  DORKOS_UPDATE_CHECK_DISABLED: undefined as string | undefined,
}));
vi.mock('../../../env.js', () => ({ env: envMock }));

import { getLatestVersion, resetCache, settleRefresh } from '../update-checker.js';
import * as versionModule from '../../../lib/version.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const HOUR = 60 * 60 * 1000;

/** A registry answer naming `version`. */
function answers(version: string) {
  return { ok: true, json: () => Promise.resolve({ version }) };
}

/** Read once, let the background refresh land, and read again. */
async function readAfterRefresh(): Promise<string | null> {
  await getLatestVersion();
  await settleRefresh();
  return getLatestVersion();
}

describe('update-checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T12:00:00Z'));
    resetCache();
    // Default to production mode
    vi.mocked(versionModule).IS_DEV_BUILD = false as never;
    role.value = 'computer';
    envMock.DORKOS_UPDATE_CHECK_DISABLED = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never asks the registry on a hub, which DorkOS Cloud upgrades instead', async () => {
    role.value = 'hub';
    expect(await readAfterRefresh()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never asks the registry on an agent computer, whose hub picks its image', async () => {
    role.value = 'agent-computer';
    expect(await readAfterRefresh()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never asks the registry when DORKOS_UPDATE_CHECK_DISABLED is set', async () => {
    envMock.DORKOS_UPDATE_CHECK_DISABLED = '1';
    expect(await readAfterRefresh()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('answers from the cache at once and fetches in the background (DOR-3226)', async () => {
    mockFetch.mockResolvedValue(answers('0.2.0'));

    expect(await getLatestVersion()).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await settleRefresh();
    expect(await getLatestVersion()).toBe('0.2.0');
  });

  it('answers at once while the registry hangs', async () => {
    mockFetch.mockReturnValue(new Promise<never>(() => {}));

    // Resolves without any timer advancing: nothing here waits on the fetch.
    expect(await getLatestVersion()).toBeNull();
    expect(await getLatestVersion()).toBeNull();
    // One check in flight, never two.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached value within TTL', async () => {
    mockFetch.mockResolvedValue(answers('0.2.0'));

    expect(await readAfterRefresh()).toBe('0.2.0');
    expect(await getLatestVersion()).toBe('0.2.0');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after TTL expires, answering the old value until it lands', async () => {
    mockFetch.mockResolvedValueOnce(answers('0.2.0')).mockResolvedValueOnce(answers('0.3.0'));

    await readAfterRefresh();
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(await getLatestVersion()).toBe('0.2.0');
    await settleRefresh();
    expect(await getLatestVersion()).toBe('0.3.0');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the stale value on fetch failure', async () => {
    mockFetch
      .mockResolvedValueOnce(answers('0.2.0'))
      .mockRejectedValueOnce(new Error('Network error'));

    await readAfterRefresh();
    vi.advanceTimersByTime(HOUR + 1);
    expect(await readAfterRefresh()).toBe('0.2.0');
  });

  it('keeps the stale value on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(answers('0.2.0')).mockResolvedValueOnce({ ok: false });

    await readAfterRefresh();
    vi.advanceTimersByTime(HOUR + 1);
    expect(await readAfterRefresh()).toBe('0.2.0');
  });

  it('does not fetch again during the back-off after a failure, then retries', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    expect(await readAfterRefresh()).toBeNull();
    expect(await readAfterRefresh()).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValueOnce(answers('0.4.0'));
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(await readAfterRefresh()).toBe('0.4.0');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a number', 1],
    ['a missing version', undefined],
    ['text', 'latest'],
    ['markup', '<script>alert(1)</script>'],
    ['a leading v', 'v1.2.3'],
    ['two parts', '1.2'],
    ['a leading zero', '01.2.3'],
    ['an over-long pre-release', `1.2.3-${'a'.repeat(80)}`],
  ])('treats %s from the registry as a failed check, with the back-off', async (_name, version) => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version }) });

    expect(await readAfterRefresh()).toBeNull();
    expect(await readAfterRefresh()).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good version when the registry answers garbage', async () => {
    mockFetch
      .mockResolvedValueOnce(answers('0.2.0'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'nope' }) });

    await readAfterRefresh();
    vi.advanceTimersByTime(HOUR + 1);
    expect(await readAfterRefresh()).toBe('0.2.0');
  });

  it('accepts a pre-release and a build', async () => {
    mockFetch.mockResolvedValueOnce(answers('1.2.3-beta.1+build.5'));
    expect(await readAfterRefresh()).toBe('1.2.3-beta.1+build.5');
  });

  it('records a timed-out check as a failure', async () => {
    mockFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    await getLatestVersion();
    vi.advanceTimersByTime(5000);
    await settleRefresh();
    expect(await getLatestVersion()).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  describe('dev mode guard', () => {
    it('returns null immediately when IS_DEV_BUILD is true', async () => {
      vi.mocked(versionModule).IS_DEV_BUILD = true as never;
      expect(await readAfterRefresh()).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not fetch or answer the cache when in dev mode', async () => {
      // First, fetch in production mode to populate cache
      mockFetch.mockResolvedValue(answers('0.2.0'));
      await readAfterRefresh();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Switch to dev mode — should return null without touching cache
      vi.mocked(versionModule).IS_DEV_BUILD = true as never;
      expect(await getLatestVersion()).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch
    });
  });
});
