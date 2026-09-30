/**
 * Keep only the copies of extensions that actually run.
 *
 * When one extension is installed in several projects from the same trusted
 * source, the newest copy runs everywhere and `GET /api/extensions` also lists
 * each older copy with `shadowedBy` set (spec `flow-multiproject` §9.2), so an
 * extension can tell a person a project holds an older copy. Everything in the
 * app that loads, lists or toggles extensions wants one record per id: the
 * copy that runs.
 *
 * @module entities/extension/lib/running-copies
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

/**
 * Drop every copy a newer one shadows.
 *
 * @param records - What `GET /api/extensions` answered.
 * @returns One record per id: the copy that runs.
 */
export function runningCopiesOnly(
  records: readonly ExtensionRecordPublic[]
): ExtensionRecordPublic[] {
  return records.filter((record) => !record.shadowedBy);
}
