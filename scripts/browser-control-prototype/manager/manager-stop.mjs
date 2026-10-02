import { rm } from 'node:fs/promises';
import { BrowserManagerError } from '../manager-error.mjs';
import { strictProcessIdentity } from '../profile-reservation.mjs';

/** Keep the existing close/root deadlines and refuse release until exact root exit is observed. */
export async function stopManagedBrowser(record) {
  record.status = 'stopping';
  let timer;
  const timedOut = Symbol('context-close-timeout');
  try {
    await Promise.race([
      record.context.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timedOut), 2000);
      }),
    ]);
  } catch (cause) {
    record.status = 'stop-failed';
    const error = new BrowserManagerError('BROWSER_STOP_FAILED');
    error.stopFailureCode = cause === timedOut ? 'CONTEXT_CLOSE_TIMEOUT' : 'CONTEXT_CLOSE_REJECTED';
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try {
    const deadline = Date.now() + 2000;
    while (
      record.process &&
      strictProcessIdentity(record.process.pid)?.birth === record.process.birth &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (record.process && strictProcessIdentity(record.process.pid)?.birth === record.process.birth)
      throw new BrowserManagerError('BROWSER_STILL_RUNNING');
    if (record.reservation) record.reservation.release();
    else await rm(record.profileDir, { recursive: true, force: true });
  } catch (error) {
    record.status = 'stop-failed';
    throw error;
  }
  record.status = 'stopped';
}

const codes = new Set([
  'BROWSER_STOP_FAILED',
  'BROWSER_STILL_RUNNING',
  'PROCESS_IDENTITY_UNAVAILABLE',
  'BROWSER_IDENTITY_UNAVAILABLE',
  'OWNERSHIP_CHANGED',
  'UNKNOWN_OWNER',
  'UNKNOWN_BROWSER_HOLDER',
  'UNSAFE_DIRECTORY',
]);
const closeCodes = new Set(['CONTEXT_CLOSE_TIMEOUT', 'CONTEXT_CLOSE_REJECTED']);

/** Fixed, bounded summaries omit exception messages, paths, URLs and Chromium stderr. */
export function shutdownFailure(browserIds, outcomes) {
  const failures = [];
  let count = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome.status !== 'rejected') continue;
    count++;
    if (failures.length === 32) continue;
    const reason = outcome.reason;
    const browserId = /^browser-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(browserIds[i])
      ? browserIds[i]
      : '[unknown-browser]';
    failures.push({
      browserId,
      code: codes.has(reason?.code) ? reason.code : 'CLEANUP_FAILED',
      ...(closeCodes.has(reason?.stopFailureCode)
        ? { stopFailureCode: reason.stopFailureCode }
        : {}),
    });
  }
  if (!count) return null;
  const error = new BrowserManagerError('SHUTDOWN_FAILED');
  error.failures = failures;
  error.omittedFailures = count - failures.length;
  return error;
}
