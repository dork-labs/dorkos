/**
 * The card that asks a person before an agent's own folder allow list applies
 * (DOR-3039), its wait, and the decision it records, on the space side (spec
 * `computer-side-starts-alone` §5.7).
 *
 * The same token-and-retry card the hook projection raises
 * (`hook-card-ask.ts`), for the same kind of decision: a file the agent can
 * edit wants to widen what runs without asking. The card names the agent and
 * every rule (`@dorkos/shared/folder-allows-card`); the answer is recorded in
 * `folder-decisions.ts` against a digest of exactly those rules, before the
 * computer hears it.
 *
 * @module services/core/approvals/computer-asks/folder-allows-card-ask
 */
import path from 'node:path';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { AskAnswer, FolderAllowRequest } from '@dorkos/shared/computer-asks';
import { summariseFolderAllows } from '@dorkos/shared/folder-allows-card';
import { hashApprovalInput } from '@dorkos/shared/approval-text';
import type {
  ApprovalBinding,
  ApprovalConsumeResult,
  ApprovalRequestInput,
  ApprovalTicket,
} from '../approval-service.js';
import { logger } from '../../../../lib/logger.js';
import { recordFolderAllowApproval, recordFolderAllowRefusal } from './folder-decisions.js';

/**
 * What the card is about. Not a capability anyone can invoke, so
 * `connector-events-approvals.ts` resolves its title from
 * {@link describeFolderAllowCapability}.
 */
export const FOLDER_ALLOWS_CAPABILITY_ID = 'runtime.apply_folder_allows';

/** The card's title, fixed like the hook card's; the summary names the agent. */
export const FOLDER_ALLOWS_CAPABILITY_TITLE = 'Let an agent run commands without asking';

/**
 * Describe {@link FOLDER_ALLOWS_CAPABILITY_ID} for an approval card.
 * `destructive`, as the hook card is: it widens what runs without asking.
 *
 * @param capabilityId - The id `ApprovalService` is resolving.
 */
export function describeFolderAllowCapability(
  capabilityId: string
): { title: string; tier: CapabilityTier } | undefined {
  if (capabilityId !== FOLDER_ALLOWS_CAPABILITY_ID) return undefined;
  return { title: FOLDER_ALLOWS_CAPABILITY_TITLE, tier: 'destructive' };
}

/** The slice of `ApprovalService` the folder and repo cards use. */
export interface FolderAllowApprovalGateway {
  /** Record a pending approval and return the one-time token to retry with. */
  request(input: ApprovalRequestInput): ApprovalTicket;
  /** Present the token for the action it was granted for. */
  consume(token: string, binding: ApprovalBinding): ApprovalConsumeResult;
}

/** Seams the wait loop uses, injectable so tests do not sleep in real time. */
export const _internal = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
  pollIntervalMs: 5_000,
};

/**
 * Ask a person whether this agent's list may apply, wait for the answer, and
 * record it. Fails closed on everything but an explicit yes; only an explicit
 * no is recorded, so a missed card asks again on a later turn.
 *
 * @param gateway - The approval primitive.
 * @param request - The agent and its rules.
 * @returns The answer; only `granted` lets the list apply.
 */
export async function raiseFolderAllowsCard(
  gateway: FolderAllowApprovalGateway,
  request: FolderAllowRequest
): Promise<AskAnswer> {
  const binding: ApprovalBinding = {
    capabilityId: FOLDER_ALLOWS_CAPABILITY_ID,
    // The same facts the stored entry digests, so a token granted for one
    // list can never be spent on another.
    inputHash: hashApprovalInput({
      agentId: request.agentId,
      home: path.resolve(request.home),
      rules: [...request.rules],
    }),
  };
  const ticket = gateway.request({
    ...binding,
    summary: summariseFolderAllows(request),
    requestedBy: request.agentName,
  });
  logger.info('[FolderAllows] Waiting on a person to allow an agent folder allow list', {
    agentId: request.agentId,
    approvalId: ticket.approvalId,
    rules: request.rules.length,
  });
  const deadline = new Date(ticket.expiresAt).getTime();
  for (;;) {
    const result = gateway.consume(ticket.token, binding);
    if (result.outcome === 'granted') {
      recordFolderAllowApproval(request);
      logger.info('[FolderAllows] Allowed', { agentId: request.agentId });
      return { outcome: 'granted' };
    }
    if (result.outcome !== 'pending') {
      if (result.outcome === 'denied') recordFolderAllowRefusal(request);
      logger.info('[FolderAllows] Not allowed', {
        agentId: request.agentId,
        outcome: result.outcome,
      });
      return { outcome: result.outcome };
    }
    if (Number.isFinite(deadline) && Date.now() > deadline) return { outcome: 'timed_out' };
    await _internal.sleep(_internal.pollIntervalMs);
  }
}
