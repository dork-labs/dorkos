/**
 * The last answer a strict record rebuild gave for each install that still has
 * no record (DOR-2197 review, DOR-2320): why the background sweep or "Check
 * files" could not record its files. Verification reports it, so the
 * Installed view shows the reason instead of a button that would only say the
 * same thing again.
 *
 * In memory only: the sweep after every boot answers again for every legacy
 * install, so nothing here has to outlive the process.
 *
 * @module services/marketplace/lib/integrity/check-results
 */
import path from 'node:path';
import type { InstallCheckResult } from '@dorkos/shared/marketplace-schemas';
import { describeStrictRebuild, type StrictRebuildResult } from './strict-record.js';

const lastResults = new Map<string, InstallCheckResult>();

/**
 * Remember what a strict rebuild of `root` answered. A rebuild that wrote a
 * record, or found nothing to do, forgets any earlier answer.
 *
 * @param root - The install folder.
 * @param name - The package name, for the sentence.
 * @param result - What the rebuild returned.
 */
export function rememberCheck(root: string, name: string, result: StrictRebuildResult): void {
  const key = path.resolve(root);
  if (result.outcome === 'rebuilt' || result.outcome === 'not-needed') {
    lastResults.delete(key);
    return;
  }
  lastResults.set(key, { outcome: result.outcome, message: describeStrictRebuild(name, result) });
}

/**
 * The last answer remembered for `root`, if any.
 *
 * @param root - The install folder.
 */
export function lastCheck(root: string): InstallCheckResult | undefined {
  return lastResults.get(path.resolve(root));
}

/**
 * Forget every remembered answer.
 *
 * @internal
 */
export function _resetCheckResultsForTests(): void {
  lastResults.clear();
}
