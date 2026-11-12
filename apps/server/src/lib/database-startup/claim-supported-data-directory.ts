/** Take the instance lock, then prove the database can upgrade before startup. */
import path from 'node:path';
import { assertSupportedDatabaseUpgrade } from '@dorkos/db';
import { acquireInstanceLock, type AcquireInstanceLockInput } from '../instance-lock.js';

/**
 * Claim before checking; release the claim if preflight refuses or cannot read.
 * Callers keep the returned lease until handoff, shutdown, or a later boot failure.
 * @param input - The data directory, provisional port, and current version.
 */
export function claimSupportedDataDirectory(input: AcquireInstanceLockInput) {
  const lock = acquireInstanceLock(input);
  if (!lock.acquired) return lock;
  try {
    assertSupportedDatabaseUpgrade(path.join(input.dorkHome, 'dork.db'));
    return lock;
  } catch (error) {
    lock.release();
    throw error;
  }
}
