/**
 * What the permission gate does with a paid run (DOR-4204 PR 2, spec 1.0
 * §4.1). The connector preflight decides, from the meter, whether a paid run
 * runs quietly, asks, or is refused; this turns that answer into the call's
 * permission, in one place.
 *
 * It only ever makes a call stricter: a Blocked call stays Blocked, a call
 * that would have run unasked asks a person, and a refusal never reaches a
 * card at all.
 *
 * @module services/core/capabilities/spend-permission
 */
import type { ApprovalSpend } from '@dorkos/shared/approval-schemas';
import { CapabilityToolError } from './mcp-envelope.js';
import type { CallPermission } from './permission-enforcement.js';

/** Why a paid run asks a person. */
export type SpendAskReason = 'no-limit' | 'unknown-price' | 'meter-unreadable';

/** What the connector preflight tells the gate about one paid run. */
export type SpendPreflight =
  | { kind: 'run' }
  | { kind: 'ask'; reason: SpendAskReason; card: ApprovalSpend }
  | { kind: 'refuse'; code: 'SPEND_LIMIT' | 'SPEND_OUTSIDER'; message: string };

/**
 * Refuse a paid run the preflight refused: past the limit, or on an
 * outsider-marked turn. No card is raised (spec §4.1, Security Must 1).
 *
 * @param spend - The preflight's answer, if the run is paid.
 * @throws {CapabilityToolError} When the answer is a refusal.
 */
export function refuseSpend(spend: SpendPreflight | undefined): void {
  if (spend?.kind === 'refuse') {
    throw new CapabilityToolError({ error: spend.message, code: spend.code });
  }
}

/**
 * The permission for a paid run that must ask: a card at every level, Full
 * and Bypass included, because a limit is the only standing yes for money.
 *
 * @param resolved - What the permission gate resolved, or `null` when no area governs it.
 */
export function spendPermission(resolved: CallPermission | null): CallPermission {
  if (resolved?.state === 'blocked') return resolved;
  return {
    area: resolved?.area ?? 'connections',
    state: 'ask',
    source: 'always-asks',
    layer: 'floor',
  };
}
