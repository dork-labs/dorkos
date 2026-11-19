/**
 * The places an app may show in right now (DOR-4282): the ones its approval
 * covers, plus the grace below. Read by the screen gate (through
 * `allowedSlots` on the app's public record) and by `ctx.inbox`, so a place
 * the person has not allowed is drawn nowhere and gets no data.
 *
 * ## New places wait on their own
 *
 * When new places are ALL an update adds, the app keeps running with what its
 * approval covered ({@link allowedPlacesOf}), and each new place stays off
 * until a person allows it ({@link waitingPlacesOf}, which the approval queue
 * turns into a re-ask). A place counts as allowed only when the stored
 * approval names it (`approvedPermissions[id].slots`), never because the
 * manifest says so. DorkOS's own apps and apps from a source the person
 * trusts outright show in every place they declare.
 *
 * ## Grace for an approval from before places were recorded
 *
 * Since DOR-4282 an app shows only in the places its manifest declares in
 * `contributions`. An app approved before then (its approval records no
 * `slots`) may not declare any yet, and its card did name two: a panel tab
 * and a Settings page. So those keep showing, and Settings asks the person
 * to update it, rather than going blank on upgrade. The grace is narrow:
 *
 * 1. Only an approval that records no `slots`. One given since never has it.
 * 2. Only places that approval already covers ({@link legacyApprovedSlots}):
 *    `right-panel` and `settings.tabs`. (`pages` would count only for card
 *    text saved with the yes, and no stored approval carries any today.)
 *    Never a place the app starts using later.
 * 3. Never ⌘K, dialogs, the status bar, the Inbox or the canvas
 *    ({@link GRACE_CONTRIBUTION_KEYS}).
 * 4. Per app id: the approval stored for this id, given to this very copy.
 * 5. Tied to the content hash of the installed files: the folder digest the
 *    approval names (`approvedSources[id].digest`, the whole plugin folder
 *    for a plugin-carried copy) must equal the digest of the files now
 *    (`record.currentDigest`). Any change to any installed file ends it,
 *    an update or an edit in place alike.
 * 6. Only a copy DorkOS's installer provably put there: carried by an
 *    installed plugin with a trusted origin. A folder copied in by hand, a
 *    dev link and an app an agent made with `create_extension` get none.
 *
 * Pure: callers pass the record and the stored approvals.
 *
 * @module services/extensions/isolation/place-grace
 */
import {
  EXTENSION_CONTRIBUTION_KEYS,
  GRACE_CONTRIBUTION_KEYS,
  declaredContributions,
  declaresContribution,
  type ExtensionContributionKey,
} from '@dorkos/extension-api';
import {
  isFromTrustedSource,
  isSameStoredCopy,
  mayRunExtensionCode,
  type ExtensionApprovals,
  type ExtensionDeclaringCopy,
} from '../extension-load-policy.js';
import { legacyApprovedSlots } from './permission-coverage.js';

/**
 * The places this copy keeps showing in without declaring them, in card
 * order, or none. Places it declares are left out: those show anyway.
 *
 * @param copy - The extension record.
 * @param approvals - `config.extensions`.
 * @param storedCardText - Card text saved with the approval when granted
 *   ({@link legacyApprovedSlots}); none is stored today.
 */
export function placeGraceOf(
  copy: ExtensionDeclaringCopy,
  approvals: ExtensionApprovals,
  storedCardText?: string
): ExtensionContributionKey[] {
  if (!hasGrace(copy, approvals)) return [];
  const covered = legacyApprovedSlots(storedCardText);
  return GRACE_CONTRIBUTION_KEYS.filter(
    (key) => covered.includes(key) && !declaresContribution(copy.manifest, key)
  );
}

/** Whether this copy meets every condition but the places themselves. */
function hasGrace(copy: ExtensionDeclaringCopy, approvals: ExtensionApprovals): boolean {
  if (copy.origin !== 'user') return false;
  // 1: an approval that recorded places is held to them, with no grace.
  if (approvals.approvedPermissions?.[copy.id]?.slots !== undefined) return false;
  // 6: installed by DorkOS from a source it can prove, never linked.
  if (copy.devLink || !copy.sourcePlugin || !copy.trustedOrigin) return false;
  // 4: the yes stored for this id, given to this very copy by a person.
  const source = approvals.approvedSources?.[copy.id];
  if (!source || !isSameStoredCopy(copy, source)) return false;
  if (source.devLink || source.authorHome || source.autoApprovedBy) return false;
  // 5: the installed files are exactly the ones that yes named.
  if (!source.digest || source.digest !== copy.currentDigest) return false;
  return mayRunExtensionCode(copy, approvals);
}

/**
 * The places this copy may show in right now, in card order: every place it
 * declares that its stored approval covers, plus its grace
 * ({@link placeGraceOf}). Every declared place for DorkOS's own apps and for
 * a copy from a source the person trusts outright; none for a copy that may
 * not run at all. Never a place only the manifest names.
 *
 * @param copy - The extension record.
 * @param approvals - `config.extensions`.
 * @param storedCardText - As for {@link placeGraceOf}.
 */
export function allowedPlacesOf(
  copy: ExtensionDeclaringCopy,
  approvals: ExtensionApprovals,
  storedCardText?: string
): ExtensionContributionKey[] {
  const declared = declaredContributions(copy.manifest);
  if (copy.origin === 'core' || isFromTrustedSource(copy, approvals)) return declared;
  if (!mayRunExtensionCode(copy, approvals)) return [];
  const covered =
    approvals.approvedPermissions?.[copy.id]?.slots ?? legacyApprovedSlots(storedCardText);
  const grace = placeGraceOf(copy, approvals, storedCardText);
  return EXTENSION_CONTRIBUTION_KEYS.filter(
    (key) => (declared.includes(key) && covered.includes(key)) || grace.includes(key)
  );
}

/**
 * The places this copy declares that wait for a person while the rest of it
 * runs, in card order: what the approval queue re-asks about. Empty for a
 * copy that may not run at all, which waits as a whole instead.
 *
 * @param copy - The extension record.
 * @param approvals - `config.extensions`.
 */
export function waitingPlacesOf(
  copy: ExtensionDeclaringCopy,
  approvals: ExtensionApprovals
): ExtensionContributionKey[] {
  if (!mayRunExtensionCode(copy, approvals)) return [];
  const allowed = allowedPlacesOf(copy, approvals);
  return declaredContributions(copy.manifest).filter((key) => !allowed.includes(key));
}
