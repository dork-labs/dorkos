/**
 * Which copies run from a verified snapshot of their files, and keeping that
 * set tidy (DOR-3068). Split from `extension-manager.ts`, which calls these on
 * every scan, approval and load.
 *
 * Three kinds of copy run from a snapshot (`extension-snapshots.ts`), never
 * from the folder an agent can write:
 *
 * - a project copy that runs by its trusted origin, not a person's yes to
 *   that folder;
 * - a copy a person approved by its exact files (a digest);
 * - a copy that keeps path trust (`extension-path-trust.ts`). Its files may
 *   change without a click, but each time they are built they are first
 *   copied and verified, so a build reads exactly the bytes that were
 *   hashed, and an edit that lands mid-build (or is reverted before the
 *   check) is never what runs. The snapshot is named by its content, so the
 *   same files always build the same bundle, which is what lets the screen
 *   half stay pinned to the bundle a person approved.
 *
 * @module services/extensions/pin/extension-snapshot-placement
 */
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { logger } from '../../../lib/logger.js';
import {
  isApprovedByDigest,
  isApprovedByOrigin,
  isApprovedByPath,
  isFromTrustedSource,
  isSameStoredCopy,
  type ExtensionApprovals,
} from '../extension-load-policy.js';
import { collectSnapshots, ensureSnapshot, snapshotRootOf } from './extension-snapshots.js';
import { configManager } from '../../core/config-manager.js';
import { digestRootOf, liveDigestOf, pinStillHolds } from './extension-content-pin.js';
import { isPathTrustApproval } from './extension-path-trust.js';
import { notePathTrustEdits } from './path-trust-edits.js';

/**
 * Point a copy at the verified snapshot of `digest`, made from its folder
 * now, or mark it changed when the folder no longer holds those files.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param record - The extension record; updated in place.
 * @param digest - The files it must run.
 * @param markOnFailure - Whether a failure marks the record changed. A yes
 *   that is refused leaves the live record exactly as it was (`false`).
 * @returns Whether it now runs from that snapshot.
 */
export async function runFromSnapshot(
  dorkHome: string,
  record: ExtensionRecord,
  digest: string,
  markOnFailure = true
): Promise<boolean> {
  const installRoot = digestRootOf(record);
  const root = await ensureSnapshot(dorkHome, installRoot, digest);
  if (root) {
    record.pinnedDigest = digest;
    record.runPath = path.join(root, path.relative(installRoot, record.path));
    return true;
  }
  if (!markOnFailure) return false;
  // Its files changed since they were read: nothing here may run.
  record.trustedOrigin = undefined;
  record.pinnedDigest = undefined;
  record.currentDigest = undefined;
  record.runPath = undefined;
  record.originProblem = 'changed';
  return false;
}

/**
 * For a copy that keeps path trust, read its live files now and point it at
 * a verified snapshot of exactly them, so the next build reads the bytes that
 * were hashed. A no-op for any other copy.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param record - The extension record; updated in place.
 * @param approvals - `config.extensions`.
 * @returns Whether this copy keeps path trust (and so was handled here).
 */
export async function refreshPathTrustRun(
  dorkHome: string,
  record: ExtensionRecord,
  approvals: ExtensionApprovals
): Promise<boolean> {
  if (record.origin !== 'user' || record.devLink) return false;
  const source = approvals.approvedSources?.[record.id];
  if (!source || !isPathTrustApproval(source) || !isSameStoredCopy(record, source)) return false;
  const live = await liveDigestOf(record);
  if (live && live === record.pinnedDigest && record.runPath) return true;
  if (!live) {
    // A folder DorkOS cannot read whole, or one that links outside itself.
    record.runPath = undefined;
    record.pinnedDigest = undefined;
    record.originProblem = 'changed';
    return true;
  }
  record.currentDigest = live;
  // Only this function marks a path-trust copy changed, so a good copy clears it.
  if (await runFromSnapshot(dorkHome, record, live)) record.originProblem = undefined;
  return true;
}

/**
 * Read a copy's live files again before a load that skips the scan (a reload by id): apply its
 * agent's level to them first, then check the copy can still run.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param record - The extension record; updated in place.
 * @returns Whether it may go on loading.
 */
export async function recheckAtItsLevel(
  dorkHome: string,
  record: ExtensionRecord
): Promise<boolean> {
  const live = await liveDigestOf(record);
  if (live) {
    const atLoad = { ...record, currentDigest: live };
    await notePathTrustEdits([atLoad], configManager.get('extensions'), dorkHome);
  }
  const approvals = configManager.get('extensions');
  // A path-trust copy is rebuilt from a verified copy of its files as they are now.
  if (await refreshPathTrustRun(dorkHome, record, approvals)) {
    return record.originProblem !== 'changed';
  }
  return pinStillHolds(record, approvals);
}

/**
 * Point every copy that runs from a snapshot at one (the three kinds in the
 * module note). A copy whose snapshot cannot be made loses its standing
 * instead of running from the folder.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param records - The copies this scan chose.
 * @param approvals - `config.extensions`.
 */
export async function placeSnapshots(
  dorkHome: string,
  records: readonly ExtensionRecord[],
  approvals: ExtensionApprovals
): Promise<void> {
  for (const record of records) {
    if (record.origin !== 'user' || record.devLink) continue;
    if (await refreshPathTrustRun(dorkHome, record, approvals)) continue;
    // A yes pinned to these exact files runs them from the snapshot, at any
    // scope, plugin-carried or installed directly.
    const pinned = isApprovedByDigest(record, approvals);
    if (pinned) record.pinnedDigest = record.currentDigest;
    const byOrigin =
      record.scope === 'local' &&
      !!record.sourcePlugin &&
      !!record.trustedOrigin &&
      !isApprovedByPath(record, approvals) &&
      (isApprovedByOrigin(record, approvals) || isFromTrustedSource(record, approvals));
    if ((!pinned && !byOrigin) || !record.pinnedDigest) continue;
    await runFromSnapshot(dorkHome, record, record.pinnedDigest);
  }
}

/**
 * Remove every snapshot no current copy runs from and no approval names (a
 * changed copy's row compares against it). Best-effort.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param records - Every copy the manager holds.
 * @param approvals - `config.extensions`.
 */
export async function collectUnusedSnapshots(
  dorkHome: string,
  records: Iterable<ExtensionRecord>,
  approvals: ExtensionApprovals
): Promise<void> {
  const inUse = new Set<string>();
  for (const record of records) {
    if (record.runPath) inUse.add(digestRootOf({ ...record, path: record.runPath }));
  }
  for (const source of Object.values(approvals.approvedSources ?? {})) {
    const root = source.digest ? snapshotRootOf(dorkHome, source.digest) : null;
    if (root) inUse.add(path.resolve(root));
  }
  try {
    await collectSnapshots(dorkHome, inUse);
  } catch (err) {
    logger.warn('[Extensions] Could not clear unused extension snapshots', err);
  }
}
