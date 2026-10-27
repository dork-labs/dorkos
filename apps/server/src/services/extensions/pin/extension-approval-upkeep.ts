/**
 * The bookkeeping each scan does to approvals written before a newer rule
 * existed, so they keep meaning what the person meant. Each step writes only
 * when something needs it, and never widens what an approval covers. Split
 * from `extension-manager.ts`, which calls all three from its scan.
 *
 * - {@link bindUnsourcedApprovals} (DOR-2383): an approval that named no copy
 *   is bound to the one copy it could have been about.
 * - {@link ratchetFullAccessApprovals} (DOR-2686): an approval for full access
 *   is narrowed to the set a copy that now runs separately declares.
 * - {@link pinPathOnlyApprovals} (DOR-3068): an approval that named a folder
 *   but not its files is pinned, once, to the files it finds.
 * - {@link settleLegacyApprovals} (DOR-3068): after the first scan, whatever
 *   those two left unbound or unpinned is never pinned later.
 *
 * @module services/extensions/pin/extension-approval-upkeep
 */
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ApprovedPermissionSet, ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { logger } from '../../../lib/logger.js';
import { approvedSourceOf, isApprovedCopy, namesThisCopy } from '../extension-load-policy.js';
import { isPathOnlyApproval } from './extension-path-trust.js';
import { declaredSet } from '../isolation/permission-coverage.js';

/**
 * Bind each approval given before approvals recorded their copy to the one copy
 * it could have been about: the extension installed directly under
 * `{dorkHome}/extensions/<id>` (DOR-2383).
 *
 * Before that change, discovery never read a plugin's extensions and dropped a
 * project copy of an approved id, so the direct install was the only copy an
 * id-only approval ever let run. Binding it on first sight keeps it running with
 * nothing to click. An approved id this pass finds only inside a plugin, or only
 * in a project, stays unbound and so counts as not approved: that copy is asked
 * about on its own. The config migration cannot do this, because it runs before
 * anything has looked at the disk.
 *
 * @param records - The records this discovery pass produced.
 * @param dorkHome - DorkOS's data directory.
 */
export function bindUnsourcedApprovals(
  records: readonly ExtensionRecord[],
  dorkHome: string
): void {
  const before = configManager.get('extensions');
  const sources = before.approvedSources ?? {};
  const additions: Record<string, ExtensionApprovedSource> = {};
  // Only the ids the '0.126.1' migration listed as unsourced (DOR-3068): a
  // folder created later at an old approved name never inherits the approval.
  const legacy = new Set(before.legacyUnsourced ?? []);
  for (const record of records) {
    if (!legacy.has(record.id)) continue;
    if (!before.approvedToRun.includes(record.id) || sources[record.id]) continue;
    if (record.origin === 'core' || record.sourcePlugin) continue;
    const directInstall = path.join(path.resolve(dorkHome), 'extensions', record.id);
    if (path.resolve(record.path) !== directInstall) continue;
    // Named by its files from the start (DOR-3068): such an approval predates
    // content pins, so it is pinned, once, to what this scan finds.
    if (!record.currentDigest) continue;
    additions[record.id] = {
      ...approvedSourceOf(record),
      digest: record.currentDigest,
      pinnedOnFirstUse: new Date().toISOString(),
    };
  }
  if (Object.keys(additions).length === 0) return;
  const remaining = [...legacy].filter((id) => !(id in additions));
  const next = { ...before, approvedSources: { ...sources, ...additions } };
  // Bound ids leave the list; the key itself goes once nothing waits.
  if (remaining.length > 0) next.legacyUnsourced = remaining;
  else delete next.legacyUnsourced;
  configManager.set('extensions', next);
  logConfigWrite(
    'recording which copy an earlier extension approval was for',
    'extensions',
    before,
    configManager.get('extensions')
  );
}

/**
 * Pin an approval that still stands for full access to the narrower set its
 * copy now declares, the first time that copy is seen running separately
 * (DOR-2686).
 *
 * An approval given before permission sets were recorded (no entry), or to
 * a copy that ran inside DorkOS (an `in-process` entry), covers anything, so
 * moving the copy to `subprocess` is a narrowing that asks nothing. Left at
 * full access, though, the next version could add hosts, programs or agent
 * access without a card, which is the widening the set exists to catch. So
 * on first sight the record is ratcheted down to what is declared: still no
 * card now, a card for any later widening. Only for a copy approved on its
 * own: a copy that runs because its source is trusted is not held to a set.
 * Applies to dev links made before sets were recorded too.
 *
 * @param records - The records this discovery pass produced.
 */
export function ratchetFullAccessApprovals(records: readonly ExtensionRecord[]): void {
  const before = configManager.get('extensions');
  const permissions = before.approvedPermissions ?? {};
  const additions: Record<string, ApprovedPermissionSet> = {};
  for (const record of records) {
    if (record.origin !== 'user' || record.status === 'invalid') continue;
    const declared = declaredSet(record.manifest);
    if (declared.runtime !== 'subprocess') continue;
    const stored = permissions[record.id];
    if (stored && stored.runtime !== 'in-process') continue;
    if (!isApprovedCopy(record, before)) continue;
    additions[record.id] = declared;
  }
  if (Object.keys(additions).length === 0) return;
  configManager.set('extensions', {
    ...before,
    approvedPermissions: { ...permissions, ...additions },
  });
  logConfigWrite(
    'recording what an extension approved for full access now declares',
    'extensions',
    before,
    configManager.get('extensions')
  );
}

/**
 * Pin each approval given before approvals named content to the files its
 * copy holds on the first scan that sees it (DOR-3068): trust on first use,
 * once, and recorded (`pinnedOnFirstUse`, plus a config log line).
 *
 * Such an approval named a folder and trusted whatever was written there
 * after. From now on it names these files, so the next edit waits for a
 * person like any other. None of them can keep path trust: path trust needs
 * the creating agent's folder, which no approval recorded before this did.
 *
 * Runs before anything compiles, so the copy keeps running with nothing to
 * click. Idempotent: a pinned approval has a digest and is never touched
 * again, and one written since this change always carries a digest or the
 * author and grants that path trust needs. A copy with no readable digest (a
 * folder holding a link) is left alone and waits for a person.
 *
 * @param records - Every copy this scan found, shadowed ones included.
 * @returns The ids pinned.
 */
export function pinPathOnlyApprovals(records: readonly ExtensionRecord[]): string[] {
  const before = configManager.get('extensions');
  const sources = before.approvedSources ?? {};
  const pinnedAt = new Date().toISOString();
  const additions: Record<string, ExtensionApprovedSource> = {};
  for (const record of records) {
    const source = sources[record.id];
    if (record.origin !== 'user' || !source || !record.currentDigest) continue;
    if (!isPathOnlyApproval(source) || !namesThisCopy(record, before)) continue;
    const { legacyPathOnly: _legacy, ...named } = source;
    additions[record.id] = { ...named, digest: record.currentDigest, pinnedOnFirstUse: pinnedAt };
  }
  const ids = Object.keys(additions);
  if (ids.length === 0) return ids;
  configManager.set('extensions', {
    ...before,
    approvedSources: { ...sources, ...additions },
  });
  logConfigWrite(
    'pinning earlier extension approvals to the files they run',
    'extensions',
    before,
    configManager.get('extensions')
  );
  logger.info(
    `[Extensions] Pinned ${ids.length} earlier approval(s) to the files found now: ` +
      `${ids.join(', ')}. An edit to them now waits for a person.`
  );
  return ids;
}

/**
 * Every scan's bookkeeping on older approvals, in order: bind the unsourced
 * ones, ratchet full-access ones down, and pin path-only ones to their files.
 *
 * @param records - The records this scan produced.
 * @param shadowed - The copies newer ones shadow, which a pin may also name.
 * @param dorkHome - DorkOS's data directory.
 */
export function upkeepApprovals(
  records: readonly ExtensionRecord[],
  shadowed: readonly ExtensionRecord[],
  dorkHome: string
): void {
  bindUnsourcedApprovals(records, dorkHome);
  ratchetFullAccessApprovals(records);
  pinPathOnlyApprovals([...records, ...shadowed]);
}

/**
 * End the one chance older approvals get (DOR-3068). The '0.126.1' config
 * migration marks approvals written before approvals named content
 * (`legacyUnsourced`, `legacyPathOnly`); the first scan after start binds and
 * pins the ones whose copy it finds. Anything still marked afterwards had no
 * copy then, so a folder that appears later at that name never inherits the
 * old yes: the marks are cleared and such an approval waits for a person.
 *
 * Called once per start, after the first scan. Writes only when a mark is left.
 *
 * @returns The ids whose marks were cleared.
 */
export function settleLegacyApprovals(): string[] {
  const before = configManager.get('extensions');
  const sources = before.approvedSources ?? {};
  const cleared = new Set(before.legacyUnsourced ?? []);
  const settled: Record<string, ExtensionApprovedSource> = {};
  for (const [id, source] of Object.entries(sources)) {
    if (source.legacyPathOnly !== true) continue;
    const { legacyPathOnly: _legacy, ...rest } = source;
    settled[id] = rest;
    cleared.add(id);
  }
  if (cleared.size === 0 && before.legacyUnsourced === undefined) return [];
  const next = { ...before, approvedSources: { ...sources, ...settled } };
  delete next.legacyUnsourced;
  configManager.set('extensions', next);
  logConfigWrite(
    'ending the first-scan pin for earlier extension approvals',
    'extensions',
    before,
    configManager.get('extensions')
  );
  return [...cleared];
}

/**
 * Stop trusting `source` (spec `flow-multiproject` §9.3), keeping what is on
 * running. Each turned-on copy that runs today only because of this source is
 * given its own approval, pinned to that copy (its folder and plugin, never
 * the origin) and its files' digest (DOR-3068), so it keeps running from its
 * verified snapshot and any change asks again. One whose files DorkOS cannot
 * read has nothing to name, so it stops. Everything else from the source asks
 * again. Split from `extension-manager.ts`, whose person-bar route calls it.
 *
 * @param source - A normalized `owner/repo`.
 * @param records - Every copy the manager holds.
 * @param isOn - Whether an id is turned on.
 * @returns Whether the source was trusted.
 */
export function untrustSourceApprovals(
  source: string,
  records: Iterable<ExtensionRecord>,
  isOn: (id: string) => boolean
): boolean {
  const before = configManager.get('extensions');
  const trusted = before.trustedSources ?? [];
  if (!trusted.some((entry) => entry.source === source)) return false;
  const approvedToRun = [...before.approvedToRun];
  const approvedSources = { ...(before.approvedSources ?? {}) };
  const approvedPermissions = { ...(before.approvedPermissions ?? {}) };
  for (const rec of records) {
    if (rec.origin !== 'user' || rec.trustedOrigin?.source !== source) continue;
    if (isApprovedCopy(rec, before) || !isOn(rec.id) || !rec.currentDigest) continue;
    if (!approvedToRun.includes(rec.id)) approvedToRun.push(rec.id);
    // What it declares now, so it keeps running exactly as it is and a later
    // widening asks (DOR-2686).
    approvedPermissions[rec.id] = declaredSet(rec.manifest);
    // No origin, so a newer copy from the source does not ride on it.
    const { origin: _origin, ...pinned } = approvedSourceOf(rec);
    approvedSources[rec.id] = { ...pinned, digest: rec.currentDigest };
  }
  configManager.set('extensions', {
    ...before,
    approvedToRun,
    approvedSources,
    approvedPermissions,
    trustedSources: trusted.filter((entry) => entry.source !== source),
  });
  logConfigWrite(
    'no longer trusting a code source',
    'extensions',
    before,
    configManager.get('extensions')
  );
  return true;
}
