/**
 * Which settings cards change a front-door setting or turn spending up
 * (DOR-3648, Security M1 on #3878).
 *
 * An `operator.config_patch` card stores only its input's hash, so the grant
 * route cannot read the patch back. The gate notes the front-door paths here
 * when it raises the card, and the grant route asks before allowing it: a
 * front-door change is confirmed at this computer too, the same bar the
 * settings page's own write meets.
 *
 * Kept in memory. A card this process never noted (raised before a restart,
 * or dropped past the cap) counts as touching the front door, so a lost note
 * asks for confirmation rather than skipping it.
 *
 * @module services/core/approvals/model/front-door-cards
 */
import { findOperatorOnlyPaths } from '../../operator/config-write-policy.js';
import { frontDoorPathsOf } from '../../operator/front-door-settings.js';

/** The capability whose cards carry a settings patch. */
export const CONFIG_PATCH_CAPABILITY = 'operator.config_patch';

/** How many cards are remembered; the oldest is dropped past it (and then holds). */
const MAX_NOTED_CARDS = 500;

const noted = new Map<string, readonly string[]>();

/** Read one dot path of a patch, without walking inherited properties. */
function valueAt(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * The spending settings a patch turns up, the same rule as #3878's
 * `frontDoorStepUpPaths`: turning a check onto credits off, the offer, unlinking,
 * and every chat back on its own sign-in turn spending down and are left out.
 */
function spendingPathsOf(paths: readonly string[], patch: unknown): string[] {
  return paths.filter((path) => {
    if (!path.startsWith('cloud.credits.') && path !== 'heartbeats.triageOnCredits') return false;
    const value = valueAt(patch, path);
    if (path === 'heartbeats.triageOnCredits') return value !== false;
    if (path === 'cloud.credits.offer') return false;
    if (path === 'cloud.credits.linkedTo') return value !== null;
    if (path === 'cloud.credits.defaults' && value && typeof value === 'object')
      return !Object.values(value).every(
        (entry: unknown) =>
          entry &&
          typeof entry === 'object' &&
          (!Object.hasOwn(entry, 'runsOn') ||
            (entry as { runsOn?: string }).runsOn === 'own-sign-in')
      );
    return true;
  });
}

/**
 * Note the front-door paths a settings card's patch changes. The gate calls
 * this for every card it raises; any other capability is ignored here.
 *
 * @param approvalId - The card's approval id.
 * @param capabilityId - The capability the card asks for.
 * @param input - The call's input; a settings card's carries `patch`.
 */
export function noteConfigPatchCard(
  approvalId: string,
  capabilityId: string,
  input: unknown
): void {
  if (capabilityId !== CONFIG_PATCH_CAPABILITY) return;
  const patch = (input as { patch?: unknown } | null)?.patch;
  noted.delete(approvalId);
  const paths = findOperatorOnlyPaths(patch);
  noted.set(approvalId, [...frontDoorPathsOf(paths), ...spendingPathsOf(paths, patch)]);
  while (noted.size > MAX_NOTED_CARDS) {
    const oldest = noted.keys().next().value;
    if (oldest === undefined) break;
    noted.delete(oldest);
  }
}

/**
 * Whether allowing this settings card changes a front-door setting. A card
 * this process never noted counts as yes.
 *
 * @param approvalId - The card's approval id.
 */
export function configPatchCardTouchesFrontDoor(approvalId: string): boolean {
  const paths = noted.get(approvalId);
  return paths === undefined || paths.length > 0;
}

/** Forget every note. Tests only. */
export function resetFrontDoorCardsForTests(): void {
  noted.clear();
}
