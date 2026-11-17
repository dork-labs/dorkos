/**
 * Which settings cards change a front-door setting (DOR-3648, Security M1 on
 * #3878).
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

/**
 * Note the front-door paths a settings card's patch changes.
 *
 * @param approvalId - The card's approval id.
 * @param patch - The patch the agent asked to apply.
 */
export function noteConfigPatchCard(approvalId: string, patch: unknown): void {
  noted.delete(approvalId);
  noted.set(approvalId, frontDoorPathsOf(findOperatorOnlyPaths(patch)));
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
