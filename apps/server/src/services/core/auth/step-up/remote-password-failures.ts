/** Wrong remote passwords remain visible across cancelled or replaced holds. */
import { OWNER_PASSWORD_FAILURE_WINDOW_MS } from '../owner-password.js';
import { STEP_UP_MAX_PASSWORD_TRIES } from '@dorkos/shared/step-up';

/** Cap the in-memory ledger even if many signed-in devices send wrong passwords. */
const MAX_SESSIONS = 1024;
const failures = new Map<string, { times: number[]; notified: boolean }>();

/** Count an actual wrong password; true once when this device reaches five recent failures. */
export function noteRemotePasswordFailure(sessionId: string, now = Date.now()): boolean {
  for (const [id, entry] of failures) {
    entry.times = entry.times.filter((at) => now - at < OWNER_PASSWORD_FAILURE_WINDOW_MS);
    if (entry.times.length === 0) failures.delete(id);
  }
  const entry = failures.get(sessionId) ?? { times: [], notified: false };
  entry.times.push(now);
  failures.set(sessionId, entry);
  while (failures.size > MAX_SESSIONS) failures.delete(failures.keys().next().value!);
  if (entry.notified || entry.times.length < STEP_UP_MAX_PASSWORD_TRIES) return false;
  entry.notified = true;
  return true;
}

/** A correct password starts this device's count afresh. */
export function clearRemotePasswordFailures(sessionId: string): void {
  failures.delete(sessionId);
}

/** Forget the ledger between isolated tests. */
export function resetRemotePasswordFailuresForTests(): void {
  failures.clear();
}
