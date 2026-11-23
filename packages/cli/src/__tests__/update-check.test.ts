import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkForUpdate, isNewer } from '../update-check.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { readFile, writeFile, mkdir } from 'node:fs/promises';

/** Every variable that switches the update check off. */
const SWITCHES = ['DORKOS_UPDATE_CHECK_DISABLED', 'DO_NOT_TRACK', 'DORKOS_TELEMETRY_DISABLED'];

describe('isNewer', () => {
  it('returns true when major is higher', () => {
    expect(isNewer('2.0.0', '1.0.0')).toBe(true);
  });

  it('returns true when minor is higher', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
  });

  it('returns true when patch is higher', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when version is older', () => {
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
  });

  it('returns false when lower major despite higher minor', () => {
    expect(isNewer('0.99.0', '1.0.0')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T12:00:00Z'));
    // The switches below are read from the environment; start every test off.
    for (const name of SWITCHES) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ['DORKOS_UPDATE_CHECK_DISABLED', '1'],
    ['DORKOS_UPDATE_CHECK_DISABLED', 'true'],
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'true'],
    ['DORKOS_TELEMETRY_DISABLED', '1'],
    ['DORKOS_TELEMETRY_DISABLED', 'TRUE'],
  ] as const)('honours %s=%s: no registry call, no cache read', async (name, value) => {
    vi.stubEnv(name, value);
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '9.0.0' }) });

    expect(await checkForUpdate('0.1.0')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(SWITCHES)('still checks when %s is 0', async (name) => {
    vi.stubEnv(name, '0');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '0.2.0' }) });

    expect(await checkForUpdate('0.1.0')).toBe('0.2.0');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached result when cache is fresh', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.2.0',
        checkedAt: Date.now() - 1000, // 1 second ago
      })
    );

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.2.0');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null from cache when current version is up to date', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.1.0',
        checkedAt: Date.now() - 1000,
      })
    );

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('fetches from registry when cache is stale', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.1.0',
        checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      })
    );
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.3.0' }),
    });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.3.0');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/dorkos/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('fetches from registry when no cache file exists', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.2.0');
  });

  it('returns null on network timeout', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    mockFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    mockFetch.mockRejectedValue(new Error('Network failure'));

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('returns null when registry returns non-ok response', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    mockFetch.mockResolvedValue({ ok: false });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('treats corrupt cache as cache miss', async () => {
    vi.mocked(readFile).mockResolvedValue('not-json!!!');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.2.0');
  });

  it('writes cache after successful fetch', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    await checkForUpdate('0.1.0');
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('update-check.json'),
      expect.stringContaining('"latestVersion":"0.2.0"')
    );
  });
});
