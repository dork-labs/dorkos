/**
 * An update that only adds places keeps its app running (DOR-4282, option
 * C2). When the files a person approved changed, the app normally pauses and
 * asks again. This module decides, on the server and from the files alone,
 * whether the only change is newly declared places, and if so moves the pin
 * to the new files while the approval stays exactly as it was: the new places
 * wait for the person, and everything else keeps running.
 *
 * It counts as places only when every one of these holds, and fails closed
 * otherwise (the normal files-changed card and pause):
 *
 * - **Read from snapshots only.** The scanned files are first copied into the
 *   snapshot store and verified against the scan's digest; the approved side
 *   is its own stored snapshot, verified the same way. The live folder is
 *   never compared, so it cannot be swapped between the check and the pin.
 * - **Same file set.** Both hold the same paths, dotfiles and symbolic links
 *   included, walked the way the digest walks (`coveredTreeOf`). Nothing
 *   added, removed or renamed; a link must point at the same place.
 * - **Same bytes.** Every file but the app's own `extension.json` is
 *   byte-identical, with the same executable bit. The one exception is a
 *   dork-apps rebuild (a `BUILD.json` in the app's folder): there the build
 *   banner on line 1 of `index.js` and `server.js` and `BUILD.json` may
 *   change, exactly as `places-only-rebuild.ts` allows, and nothing else.
 * - **Same manifest, apart from places.** Both manifests parse with the
 *   loader's parser, validate against the manifest schema, carry no repeated
 *   key and no `__proto__` key, and are equal in canonical form once
 *   `contributions` is left out (`places-only-manifest.ts`). Only a dork-apps
 *   rebuild may also change `version`, and never downward.
 * - **Places only added.** Every place the old manifest named keeps its value,
 *   and each new one is a known place set to exactly `true`. At least one is.
 *
 * @module services/extensions/pin/places-only-update
 */
import fs from 'fs/promises';
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import { auditTrail, recordAudit } from '../../audit/audit-trail.js';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { fileSha256Hex } from '../../marketplace/lib/records/tree-scan.js';
import {
  coveredTreeOf,
  installFolderDigest,
  type CoveredTree,
} from '../../marketplace/lib/install-digest.js';
import { logger } from '../../../lib/logger.js';
import { isSameStoredCopy, type ExtensionApprovals } from '../extension-load-policy.js';
import { digestRootOf } from './extension-content-pin.js';
import { ensureSnapshot, snapshotRootOf } from './extension-snapshots.js';
import { isPathTrustApproval } from './extension-path-trust.js';
import { placesOnlyManifestMove } from './places-only-manifest.js';
import {
  DORK_APPS_BUILD_RULE,
  rebuildOnlyRestamps,
  type RebuildCommits,
} from './places-only-rebuild.js';

/** A copy as far as the check needs it. */
type CheckedCopy = Pick<ExtensionRecord, 'path' | 'sourcePlugin'>;

/** What a places-only update moved between, for its audit line. */
export interface PlacesOnlyMove {
  /** The approved and new manifest versions. */
  version: { from: string; to: string };
  /** The approved and new build commits, when the app carries `BUILD.json`. */
  commit?: RebuildCommits;
}

/**
 * Whether two verified snapshots differ only by newly added places in the
 * app's own `extension.json`, and, for a dork-apps rebuild (a `BUILD.json`
 * in the app's folder), by what the build tool restamps
 * (`places-only-rebuild.ts`). Covers exactly what the digest covers: each
 * file's path, executable bit and bytes, and each link's text. Without a
 * `BUILD.json`, a changed version counts as changed. Reads only the two
 * folders it is given; the caller makes
 * sure each is a snapshot verified against its digest.
 *
 * @param before - The snapshot of the approved files.
 * @param after - The snapshot of the files on disk at the scan.
 * @param manifestRel - The manifest's path inside both.
 * @returns What moved, `false` when more changed, or `null` when either tree
 *   could not be read whole, so the answer is not settled and must not be
 *   remembered.
 */
export async function snapshotsOnlyAddPlaces(
  before: string,
  after: string,
  manifestRel: string
): Promise<PlacesOnlyMove | false | null> {
  const [was, is] = await Promise.all([coveredTreeOf(before), coveredTreeOf(after)]);
  if (!was || !is) return null;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  const linksOf = (tree: CoveredTree) => tree.links.map((l) => `${l.rel}\0${l.target}`);
  const filesOf = (tree: CoveredTree) => tree.files.map((f) => `${f.rel}\0${f.executable}`);
  // The same links to the same places, and the same files with the same
  // executable bit, in the same sorted order.
  if (!same(linksOf(was), linksOf(is)) || !same(filesOf(was), filesOf(is))) return false;
  const appDir = path.posix.dirname(manifestRel);
  const prefix = appDir === '.' ? '' : `${appDir}/`;
  const rule = DORK_APPS_BUILD_RULE;
  const rebuilt = is.files.some((f) => f.rel === `${prefix}${rule.buildFile}`);
  // Names in the app's folder a rule reads instead of requiring the same
  // bytes: the manifest, and for a rebuild its banner files and BUILD.json.
  const restamped = new Set<string>(['extension.json']);
  if (rebuilt) for (const name of [...rule.bannerFiles, rule.buildFile]) restamped.add(name);
  const oldFiles = new Map<string, Buffer>();
  const newFiles = new Map<string, Buffer>();
  // For a rebuild: every file in the app's folder but BUILD.json, which
  // BUILD.json must hash exactly (W3).
  const appFiles: string[] = [];
  for (let i = 0; i < was.files.length; i++) {
    const a = was.files[i]!;
    const b = is.files[i]!;
    const name = a.rel.startsWith(prefix) ? a.rel.slice(prefix.length) : null;
    if (rebuilt && name !== null && name !== rule.buildFile) appFiles.push(name);
    if (name !== null && (rebuilt || name === 'extension.json')) {
      // Read once: these same bytes are the ones checked and hashed.
      const [old, now] = await Promise.all([fs.readFile(a.abs), fs.readFile(b.abs)]);
      oldFiles.set(name, old);
      newFiles.set(name, now);
      if (!restamped.has(name) && !old.equals(now)) return false;
      continue;
    }
    if ((await fileSha256Hex(a.abs)) !== (await fileSha256Hex(b.abs))) return false;
  }
  const oldManifest = oldFiles.get('extension.json');
  const newManifest = newFiles.get('extension.json');
  if (!oldManifest || !newManifest) return false;
  const move = placesOnlyManifestMove(oldManifest.toString('utf8'), newManifest.toString('utf8'));
  if (!move) return false;
  const version = { from: move.fromVersion, to: move.toVersion };
  // An app no build tool stamps: only added places may differ, so a changed
  // version counts as changed (C2 as first ruled).
  if (!rebuilt) return version.from === version.to ? { version } : false;
  const commit = rebuildOnlyRestamps(
    { id: move.id, version: move.fromVersion, files: oldFiles },
    { id: move.id, version: move.toVersion, files: newFiles },
    appFiles
  );
  return commit ? { version, commit } : false;
}

/** How many settled answers {@link onlyPlacesAddedSince} keeps in memory. */
const SETTLED_MAX = 512;

/**
 * Pairs `(approved digest, current digest)`, for one app's manifest, already
 * found to change more than places. Both sides are named by their contents
 * and the comparison reads nothing the digest does not cover, so the answer
 * for a pair never changes, and a copy waiting on its files-changed card is
 * not copied and hashed again on every scan.
 */
const notPlacesOnly = new Set<string>();

/**
 * Whether the files at `currentDigest` differ from those at `approvedDigest`
 * only by newly added places in the copy's own `extension.json`. Read from
 * the files, never from a flag, and never from the live folder: the current
 * files are first copied into the snapshot store and verified against
 * `currentDigest`, and both sides are read from their stored snapshots, so
 * what is compared is exactly what the pin would move to.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param copy - The extension record.
 * @param approvedDigest - The digest the person approved.
 * @param currentDigest - The digest the scan read.
 * @returns What moved, or `false` whenever anything else changed, the folder
 *   no longer holds the scanned files, or either side cannot be read whole.
 */
async function onlyPlacesAddedSince(
  dorkHome: string,
  copy: CheckedCopy,
  approvedDigest: string,
  currentDigest: string
): Promise<PlacesOnlyMove | false> {
  const approvedRoot = snapshotRootOf(dorkHome, approvedDigest);
  if (!approvedRoot) return false;
  const root = digestRootOf(copy);
  const manifestRel = path
    .relative(root, path.join(path.resolve(copy.path), 'extension.json'))
    .split(path.sep)
    .join('/');
  // Keyed by the manifest too: two apps in one plugin share its digests.
  const pair = `${approvedDigest}\0${currentDigest}\0${manifestRel}`;
  if (notPlacesOnly.has(pair)) return false;
  try {
    const approved = await installFolderDigest(approvedRoot);
    if (approved.kind !== 'digest' || approved.digest !== approvedDigest) return false;
    const currentRoot = await ensureSnapshot(dorkHome, root, currentDigest);
    if (!currentRoot) return false;
    const placesOnly = await snapshotsOnlyAddPlaces(approvedRoot, currentRoot, manifestRel);
    // Only a full comparison of two verified snapshots is remembered: a tree
    // that failed to read may read whole on the next scan.
    if (placesOnly === null) return false;
    if (!placesOnly) {
      if (notPlacesOnly.size >= SETTLED_MAX) notPlacesOnly.clear();
      notPlacesOnly.add(pair);
    }
    return placesOnly;
  } catch {
    return false;
  }
}

/** Whether this copy's approval is a digest pin its files no longer match. */
function changedPinOf(
  record: ExtensionRecord,
  approvals: ExtensionApprovals
): ExtensionApprovedSource | null {
  if (record.origin !== 'user' || record.devLink || !record.currentDigest) return null;
  if (!approvals.approvedToRun.includes(record.id)) return null;
  const source = approvals.approvedSources?.[record.id];
  if (!source?.digest || source.digest === record.currentDigest) return null;
  if (!isSameStoredCopy(record, source) || isPathTrustApproval(source)) return null;
  return source;
}

/** The fixed audit line a moved pin leaves, whatever app it was. */
export const PIN_MOVED_SUMMARY = 'pin moved by places-only update';

/**
 * Move each digest pin whose copy changed only by newly added places to the
 * files on disk now (DOR-4282, option C2), before anything compiles. The
 * stored permission set is left exactly as it was, so each new place waits
 * for a person while the rest of the app keeps running; allowing one later
 * updates that set, not the pin. Any other change is left for the normal
 * files-changed card. Writes config only when a pin moves.
 *
 * A person's own yes (`personApprovedDigest`) moves with the pin only when it
 * named exactly the old pin; a stale one stays stale. Both move in the one
 * config write that moves every pin, so a failed write moves neither, and the
 * copy stays paused for the normal card. Each moved pin leaves one audit line,
 * {@link PIN_MOVED_SUMMARY}, naming the app, both digests, both versions and,
 * for a dork-apps rebuild, both build commits.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param records - The copies this scan chose; a moved copy's `pinnedDigest`
 *   is updated in place, only once the write landed.
 * @param approvals - `config.extensions`.
 * @returns The approvals to go on with: the same object when nothing moved.
 */
export async function repinPlacesOnlyUpdates(
  dorkHome: string,
  records: readonly ExtensionRecord[],
  approvals: ExtensionApprovals
): Promise<ExtensionApprovals> {
  const moved: Record<string, ExtensionApprovedSource> = {};
  const movedRecords: Array<{
    record: ExtensionRecord;
    from: string;
    to: string;
    move: PlacesOnlyMove;
  }> = [];
  for (const record of records) {
    const source = changedPinOf(record, approvals);
    if (!source?.digest || !record.currentDigest) continue;
    // Compared from a verified snapshot of exactly `currentDigest`, so the pin
    // moves to the files that were compared.
    const { currentDigest } = record;
    const move = await onlyPlacesAddedSince(dorkHome, record, source.digest, currentDigest);
    if (!move) continue;
    moved[record.id] = {
      ...source,
      digest: currentDigest,
      // The code a person approved is byte-identical, so their yes still
      // stands for it (DOR-3547). Only a yes that named the old pin exactly.
      ...(source.personApprovedDigest === source.digest
        ? { personApprovedDigest: currentDigest }
        : {}),
    };
    movedRecords.push({ record, from: source.digest, to: currentDigest, move });
  }
  if (movedRecords.length === 0) return approvals;
  const before = configManager.get('extensions');
  try {
    // One write: each pin and its person's yes land together or not at all.
    configManager.set('extensions', {
      ...before,
      approvedSources: { ...(before.approvedSources ?? {}), ...moved },
    });
  } catch (err) {
    logger.warn('[Extensions] Could not move a pin for an update that only adds places', err);
    return approvals;
  }
  logConfigWrite(
    'keeping an app approved through an update that only adds places',
    'extensions',
    before,
    configManager.get('extensions')
  );
  const system = auditTrail()?.accounts.system();
  for (const { record, from, to, move } of movedRecords) {
    record.pinnedDigest = to;
    recordAudit({
      ...(system ? { actor: system } : {}),
      source: { surface: 'system' },
      action: 'extension.pin_moved_places_only',
      operation: 'modify',
      outcome: 'ok',
      target: { type: 'extension', id: record.id, name: record.id },
      change: [
        { field: 'digest', before: from, after: to },
        { field: 'version', before: move.version.from, after: move.version.to },
        ...(move.commit
          ? [{ field: 'commit', before: move.commit.from, after: move.commit.to }]
          : []),
      ],
      summary: PIN_MOVED_SUMMARY,
    });
  }
  return configManager.get('extensions');
}
