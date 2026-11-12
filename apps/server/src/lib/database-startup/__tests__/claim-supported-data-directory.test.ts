import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSupportedDatabaseUpgrade, DatabaseUpgradeRequiredError } from '@dorkos/db';
import { acquireInstanceLock } from '../../instance-lock.js';
import { claimSupportedDataDirectory } from '../claim-supported-data-directory.js';
vi.mock('@dorkos/db', () => ({
  assertSupportedDatabaseUpgrade: vi.fn(),
  DatabaseUpgradeRequiredError: class extends Error {},
}));
vi.mock('../../instance-lock.js', () => ({ acquireInstanceLock: vi.fn() }));
const release = vi.fn();
const input = { dorkHome: '/fixture/home', port: 0, version: '0.136.0' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireInstanceLock).mockReturnValue({ acquired: true, release });
  vi.mocked(assertSupportedDatabaseUpgrade).mockImplementation(() => {});
});
describe('claim before database preflight', () => {
  it('holds the claim while preflight reads and returns the release for shutdown', () => {
    vi.mocked(assertSupportedDatabaseUpgrade).mockImplementation((file) => {
      expect(acquireInstanceLock).toHaveBeenCalledWith(input);
      expect(release).not.toHaveBeenCalled();
      expect(file).toBe('/fixture/home/dork.db');
    });
    const result = claimSupportedDataDirectory(input);
    expect(result).toEqual({ acquired: true, release });
    expect(release).not.toHaveBeenCalled();
  });
  it('never reads the database when another process owns the directory', () => {
    vi.mocked(acquireInstanceLock).mockReturnValue({ acquired: false, reason: 'fixture held' });
    expect(claimSupportedDataDirectory(input)).toEqual({ acquired: false, reason: 'fixture held' });
    expect(assertSupportedDatabaseUpgrade).not.toHaveBeenCalled();
  });
  it('releases on refusal and propagates it before the caller can start work', () => {
    const error = new DatabaseUpgradeRequiredError('/fixture/home/dork.db');
    vi.mocked(assertSupportedDatabaseUpgrade).mockImplementation(() => {
      throw error;
    });
    expect(() => claimSupportedDataDirectory(input)).toThrow(error);
    expect(release).toHaveBeenCalledExactlyOnceWith();
  });
});
