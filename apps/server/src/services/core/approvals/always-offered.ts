/**
 * Whether an approval card may offer "Always allow".
 *
 * @module services/core/approvals/always-offered
 */
import { isExtensionCapabilityId } from '@dorkos/shared/capabilities';
import { isFloorArea } from '@dorkos/shared/permissions';

/**
 * Whether a card's stored marks say a Wi-Fi sign-in's words reached the turn that raised it.
 * Read here rather than through `turn-marks.ts`, whose session imports this store must not load.
 * Marks that cannot be read count as Wi-Fi: Always allow is the thing not to offer by mistake.
 *
 * @param stored - The `origin_marks` column.
 */
function raisedFromWifi(stored: string | null | undefined): boolean {
  if (!stored) return false;
  try {
    return (JSON.parse(stored) as { wifi?: unknown } | null)?.wifi === true;
  } catch {
    return true;
  }
}

/**
 * Whether a card may offer "Always allow" (spec `agent-permissions` D7): DorkOS
 * knows which agent asked, the action has an area, that area is not a floor
 * area, and the approval is not bound to a connector's live authority. The
 * grant route refuses `answer: 'always'` by the same rules, from the same row,
 * so what a card offers and what the route accepts cannot drift.
 *
 * The last rule does not rest on connector actions having no area today. A
 * connector approval is bound to one connection, one operation revision and
 * one session (`connectorAuthority`); a standing yes would outlive every one of
 * them, which is what the old standing grants refused for connector preflight
 * too. So a card carrying that binding never offers it, whatever area a future
 * connector action is given.
 *
 * A card that shows a change to read, old → new (`describeApprovalChange`,
 * DOR-2328) or a text in full (`approvalDetailField`), never offers it either:
 * the promise of those cards is that a person sees every such change before it
 * happens, and a standing yes would let the next change through unseen.
 *
 * Nor does a card for an extension's destructive tool (DOR-2685): every call
 * asks, because the tool's tier is its author's to change and a standing yes
 * keyed by its id would outlive the version it was given for.
 *
 * Nor does a card a Wi-Fi-marked turn raised (DOR-3061): words from a Wi-Fi
 * sign-in may get one action done once, never a lasting grant.
 *
 * @param row - The stored approval.
 */
export function isAlwaysOffered(row: {
  requestedByPath: string | null;
  area: string | null;
  authorityBindingDigest: string | null;
  detail?: string | null;
  /** Required: the extension rule reads it, and a caller must not be able to forget it. */
  capabilityId: string;
  /** Required for the same reason. */
  tier: string;
  /** The marks of the turn that raised it, as stored. */
  originMarks?: string | null;
}): boolean {
  return (
    !raisedFromWifi(row.originMarks) &&
    row.requestedByPath !== null &&
    row.area !== null &&
    !isFloorArea(row.area) &&
    row.authorityBindingDigest === null &&
    (row.detail ?? null) === null &&
    !(row.tier === 'destructive' && isExtensionCapabilityId(row.capabilityId)) &&
    // A config patch asks outside its own area only for a setting a person
    // must decide each time (`areasForInput`). Permissions stopped being a
    // floor area under Trusted (DOR-2739), so this keeps that card from
    // offering Always allow, as a floor area's never does.
    !(row.capabilityId === 'operator.config_patch' && row.area !== 'settings') &&
    // An agent's permission change asks on every call that could loosen
    // anything (DOR-3107), so an Always allow on its card would change nothing.
    row.capabilityId !== 'permissions.change'
  );
}
