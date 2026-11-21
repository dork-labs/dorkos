/**
 * Give each approval from before places were recorded the places its approved
 * files declare, once, at the first scan after the upgrade (DOR-4891).
 *
 * ## Why
 *
 * Since DOR-4282 an app shows only in the places its approval names
 * (`approvedPermissions[id].slots`). An approval given before then names
 * none, so after the upgrade every place it declares beyond the two its card
 * named then waited for a fresh yes: a wall of cards for apps the person had
 * already approved. Yet the person did see those files, and the old version
 * showed the app wherever it registered. So the places the approved manifest
 * declares, where the old version showed them, are recorded as approved.
 *
 * ## The rules (Security's ruling on DOR-4891)
 *
 * An approval gets places only when every one of these holds; otherwise it is
 * left exactly as it was, and its places ask as before:
 *
 * 1. **The approved files, byte for byte.** The approval is pinned to a folder
 *    digest (`approvedSources[id].digest`, over every file, `extension.json`
 *    included) that equals the digest of the files found now, and that
 *    manifest parses. A changed, missing or unreadable manifest asks. The
 *    digest must already have been stored before this scan began: an
 *    approval this very scan pinned to whatever it found (`legacyPathOnly`,
 *    `legacyUnsourced`) names files nobody approved, so it asks.
 * 2. **Only places the old version showed** ({@link PLACES_SHOWN_BEFORE_DOR_4282}):
 *    the declared places that overlap what it rendered. A place type new
 *    with DOR-4282 (`canvas`, `inbox`) still asks.
 * 3. **Only approvals still in force.** Approved to run, the same stored copy,
 *    allowed to run now, turned on, installed (found by this scan) and valid.
 *    A dev link and a path-trust approval name no digest, so they never
 *    qualify.
 * 4. **Once, by the server.** Only the ids the `'0.140.0'` config migration
 *    listed (`extensions.legacySlotless`), only on the scans that run before
 *    `settleLegacyApprovals` clears that list after the first clean one, and
 *    only when its stored set has no `slots` key at all: a present one, `[]`
 *    included, is a person's answer and is never touched, so a list written
 *    again by hand cannot widen anything. Elsewhere `slots` is written only
 *    by a yes (a person's, or `create_extension`'s own approval of the set it
 *    declares). A scan that fails keeps the list, so the next start tries
 *    again; a second run changes nothing.
 * 5. **Visible.** One config write for the lot, and one audit entry per app
 *    naming the app and its places ({@link SLOTS_BACKFILLED_SUMMARY}).
 *
 * An approval no person gave (`autoApprovedBy: 'create_extension'`) gets places
 * only where today's path would give them without asking: that path records
 * every declared place, `slots` included, but only under the Trusted preset
 * (`extension-scaffold-approval.ts`, the posture check, then the write of
 * `declaredSet`). Under Careful it waits for a person, so such an approval
 * is left alone and its places ask (Security, DOR-4891).
 *
 * An app still on grace for places it never declared (`isolation/place-grace.ts`)
 * is left alone too: recording places ends that grace, which would take its
 * panel tab or Settings page away without a word. The cost is known: such an
 * app's other declared places (a status-bar item, say) keep asking once.
 *
 * Only `slots` is added. Every other field of the stored set stays as it was,
 * and an absent set is written as the full in-process set it already stood
 * for, so nothing else an approval covers can widen.
 *
 * @module services/extensions/pin/slots-backfill
 */
import {
  declaredContributions,
  type ExtensionContributionKey,
  type ExtensionRecord,
} from '@dorkos/extension-api';
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import { trustPosture } from '@dorkos/shared/permissions';
import { auditTrail, recordAudit } from '../../audit/audit-trail.js';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { logger } from '../../../lib/logger.js';
import {
  isEnabled,
  type CoreExtensionInfo,
  type ExtensionsConfig,
} from '../extension-enable-resolution.js';
import {
  isApprovedByDigest,
  mayRunExtensionCode,
  type ExtensionApprovals,
} from '../extension-load-policy.js';
import { placeGraceOf } from '../isolation/place-grace.js';

/**
 * The place types the client showed a user's app in before DOR-4282, pinned
 * from `main` just before it merged (`c90b139fbb019653ac1f87804c60829e52ea7c5a^`):
 * the seven `ExtensionPointId` slots in `packages/extension-api/src/extension-api.ts`
 * (`registerComponent`, `registerCommand`, `registerDialog`,
 * `registerSettingsTab`, `registerStatusBarItem`), plus `pages`
 * (`registerPage`). Nothing there checked a declaration: whatever an app
 * registered showed. `canvas` and `inbox` became declared places only with
 * DOR-4282, so they are not here and still ask.
 */
export const PLACES_SHOWN_BEFORE_DOR_4282: readonly ExtensionContributionKey[] = [
  'sidebar.footer',
  'dashboard.sections',
  'command-palette.items',
  'dialog',
  'settings.tabs',
  'right-panel',
  'status-bar',
  'pages',
];

/** The fixed audit line a backfilled approval leaves, whatever app it was. */
export const SLOTS_BACKFILLED_SUMMARY = 'places recorded for an approval from before places were';

/** What an approval with no stored set stood for: full access, in-process. */
const FULL_IN_PROCESS: ApprovedPermissionSet = {
  runtime: 'in-process',
  net: [],
  run: [],
  agents: false,
};

/** A user's own app is never core, so no core tier applies when asking if it is on. */
const NO_CORE = new Map<string, CoreExtensionInfo>();

/** The stored extensions config, as far as the backfill reads it. */
type StoredExtensions = ExtensionApprovals & ExtensionsConfig & { legacySlotless?: string[] };

/** The digest each approval was pinned to before this scan began, by id. */
export type DigestsBeforeScan = Readonly<Record<string, string | undefined>>;

/**
 * The places one listed copy gets, sorted, or `null` when it gets none (any
 * rule fails, or it declares no place the old version showed). Pure.
 *
 * @param record - A copy this scan found.
 * @param stored - `config.extensions`.
 * @param pinnedBefore - The digest each approval held before this scan.
 * @param trusted - Whether the Trusted preset is on, so an agent's own
 *   approval would record its places without asking today.
 */
function backfilledSlotsOf(
  record: ExtensionRecord,
  stored: StoredExtensions,
  pinnedBefore: DigestsBeforeScan,
  trusted: boolean
): ExtensionContributionKey[] | null {
  if (!(stored.legacySlotless ?? []).includes(record.id)) return null;
  if (record.origin !== 'user' || record.devLink) return null;
  if (record.status === 'invalid' || record.status === 'incompatible') return null;
  if (record.status === 'disabled' || !isEnabled(record.id, stored, NO_CORE)) return null;
  if (!stored.approvedToRun.includes(record.id)) return null;
  // Only a set with no `slots` key at all. A present one, `[]` included, is a
  // person's recorded answer, which a re-planted list must never widen.
  const set = stored.approvedPermissions?.[record.id];
  if (set && 'slots' in set) return null;
  const source = stored.approvedSources?.[record.id];
  if (!source?.digest || source.devLink) return null;
  // Pinned before this scan: never a pin this scan wrote to whatever it found.
  if (pinnedBefore[record.id] !== source.digest) return null;
  // Parity with today's agent approval, which records places only under Trusted.
  if (source.autoApprovedBy && !trusted) return null;
  // Rule 1: pinned to these very files, found at this copy's path and plugin.
  if (!isApprovedByDigest(record, stored)) return null;
  if (!mayRunExtensionCode(record, stored)) return null;
  if (placeGraceOf(record, stored).length > 0) return null;
  const declared = declaredContributions(record.manifest);
  const slots = PLACES_SHOWN_BEFORE_DOR_4282.filter((key) => declared.includes(key)).sort();
  return slots.length > 0 ? slots : null;
}

/**
 * Record, for each listed approval that meets every rule, the places its
 * approved files declare where the old version showed them (see the module
 * doc). One config write for all of them, then one audit entry each. Writes
 * nothing when none qualifies. A failed write throws, so the scan fails and
 * the list stays for the next start.
 *
 * @param records - The copies this scan chose.
 * @param pinnedBefore - The digest each approval held before this scan's
 *   upkeep ran ({@link digestsBeforeScan}).
 * @returns The ids given places.
 */
export function backfillSlotlessApprovals(
  records: readonly ExtensionRecord[],
  pinnedBefore: DigestsBeforeScan
): string[] {
  const before = configManager.get('extensions');
  if (!before.legacySlotless?.length) return [];
  const trusted = trustPosture(configManager.get('permissions')?.preset) === 'trusted';
  const permissions = before.approvedPermissions ?? {};
  const additions: Record<string, ApprovedPermissionSet> = {};
  const given: { record: ExtensionRecord; slots: ExtensionContributionKey[] }[] = [];
  for (const record of records) {
    if (record.id in additions) continue;
    const slots = backfilledSlotsOf(record, before, pinnedBefore, trusted);
    if (!slots) continue;
    additions[record.id] = { ...(permissions[record.id] ?? FULL_IN_PROCESS), slots };
    given.push({ record, slots });
  }
  if (given.length === 0) return [];
  configManager.set('extensions', {
    ...before,
    approvedPermissions: { ...permissions, ...additions },
  });
  logConfigWrite(
    'recording the places earlier extension approvals cover',
    'extensions',
    before,
    configManager.get('extensions')
  );
  const system = auditTrail()?.accounts.system();
  for (const { record, slots } of given) {
    recordAudit({
      ...(system ? { actor: system } : {}),
      source: { surface: 'system' },
      action: 'extension.slots_backfilled',
      operation: 'modify',
      outcome: 'ok',
      target: { type: 'extension', id: record.id, name: record.manifest.name || record.id },
      change: [{ field: 'slots', before: null, after: slots }],
      summary: SLOTS_BACKFILLED_SUMMARY,
    });
  }
  const ids = given.map((entry) => entry.record.id);
  logger.info(
    `[Extensions] Recorded the places ${ids.length} earlier approval(s) cover: ${ids.join(', ')}.`
  );
  return ids;
}

/**
 * The digest each approval is pinned to right now, by id: read at the start of
 * a scan's upkeep, before any step there pins an older approval to the files
 * it finds, and handed to {@link backfillSlotlessApprovals}.
 */
export function digestsBeforeScan(): DigestsBeforeScan {
  const sources = configManager.get('extensions').approvedSources ?? {};
  return Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, source.digest]));
}
