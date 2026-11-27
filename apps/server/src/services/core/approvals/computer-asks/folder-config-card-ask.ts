/**
 * The card that asks a person before an agent's changed folder settings run
 * (DOR-3068), its wait, and the decision it records, on the space side (spec
 * `computer-side-starts-alone` §5.7).
 *
 * The same token-and-retry card the folder allow list raises
 * (`folder-allows-card-ask.ts`), through the same approval gateway. The card
 * names the agent and which of its settings changed, never their contents
 * (those are its detail, which the computer reads from the folder); the answer
 * is recorded in `folder-decisions.ts` against the exact digests the card was
 * raised for, before the computer hears it.
 *
 * @module services/core/approvals/computer-asks/folder-config-card-ask
 */
import path from 'node:path';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type {
  AskAnswer,
  AskWatch,
  FolderConfigPart,
  FolderConfigRequest,
} from '@dorkos/shared/computer-asks';
import { hashApprovalInput, quoteSummaryValue, storableDetail } from '@dorkos/shared/approval-text';
import type { ApprovalBinding } from '../approval-service.js';
import { logger } from '../../../../lib/logger.js';
import type { FolderAllowApprovalGateway } from './folder-allows-card-ask.js';
import { recordFolderConfigApproval, recordFolderConfigRefusal } from './folder-decisions.js';

/**
 * What the card is about. Not a capability anyone can invoke, so
 * `connector-events-approvals.ts` resolves its title from
 * {@link describeFolderConfigCapability}.
 */
export const FOLDER_CONFIG_CAPABILITY_ID = 'runtime.apply_folder_config';

/** The card's title; the summary names the agent and what changed. */
export const FOLDER_CONFIG_CAPABILITY_TITLE = "Let an agent's folder settings run";

/**
 * Describe {@link FOLDER_CONFIG_CAPABILITY_ID} for an approval card.
 * `destructive`, as the hook card is: a yes lets code run unattended.
 *
 * @param capabilityId - The id `ApprovalService` is resolving.
 */
export function describeFolderConfigCapability(
  capabilityId: string
): { title: string; tier: CapabilityTier } | undefined {
  if (capabilityId !== FOLDER_CONFIG_CAPABILITY_ID) return undefined;
  return { title: FOLDER_CONFIG_CAPABILITY_TITLE, tier: 'destructive' };
}

/** How a card names each part, in plain words. */
const PART_WORDS: Record<FolderConfigPart, string> = {
  hooks: 'its hooks',
  mcpJson: 'its MCP servers file',
  manifest: "its agent file's MCP servers or account",
};

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The sentence on the card: who changed what, and what holds until a person
 * answers. Never the settings themselves.
 *
 * @param request - The agent and the parts that changed.
 */
export function summariseFolderConfig(request: FolderConfigRequest): string {
  const name = quoteSummaryValue(request.agentName);
  const changed = listOf(request.changed.map((part) => PART_WORDS[part]));
  return `${name} changed ${changed}. Its turns run without the change until you allow it.`;
}

/** Seams the wait loop uses, injectable so tests do not sleep in real time. */
export const _internal = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
  pollIntervalMs: 5_000,
};

/** The approval primitive, with the no it uses to take a stale card down. */
type FolderConfigApprovalGateway = FolderAllowApprovalGateway & {
  deny?: (approvalId: string, reason?: string) => unknown;
};

/**
 * Ask a person whether this state of the agent's settings may run, wait for
 * the answer, and record it. Fails closed on everything but an explicit yes;
 * only an explicit no is recorded. A folder that changed again while the card
 * was open takes the card down (`changed`), recording nothing.
 *
 * @param gateway - The approval primitive.
 * @param request - The agent, its home, the digests and what changed.
 * @param watch - Reads the folder again, between presentations.
 * @returns The answer; only `granted` lets the settings run.
 */
export async function raiseFolderConfigCard(
  gateway: FolderConfigApprovalGateway,
  request: FolderConfigRequest,
  watch?: AskWatch
): Promise<AskAnswer> {
  const binding: ApprovalBinding = {
    capabilityId: FOLDER_CONFIG_CAPABILITY_ID,
    // The same facts the stored entry digests, so a token granted for one
    // state can never be spent on another.
    inputHash: hashApprovalInput({
      agentId: request.agentId,
      home: path.resolve(request.home),
      parts: { ...request.digests },
    }),
  };
  const ticket = gateway.request({
    ...binding,
    summary: summariseFolderConfig(request),
    // A card with a detail never offers "Always": every change is seen first.
    ...(request.detail ? { detail: storableDetail(request.detail) } : {}),
    requestedBy: request.agentName,
  });
  logger.info("[FolderConfig] Waiting on a person to allow an agent's changed folder settings", {
    agentId: request.agentId,
    approvalId: ticket.approvalId,
    changed: request.changed,
  });
  const deadline = new Date(ticket.expiresAt).getTime();
  for (;;) {
    const result = gateway.consume(ticket.token, binding);
    if (result.outcome === 'granted') {
      recordFolderConfigApproval(request);
      logger.info('[FolderConfig] Allowed', { agentId: request.agentId });
      return { outcome: 'granted' };
    }
    if (result.outcome !== 'pending') {
      if (result.outcome === 'denied') recordFolderConfigRefusal(request);
      logger.info('[FolderConfig] Not allowed', {
        agentId: request.agentId,
        outcome: result.outcome,
      });
      return { outcome: result.outcome };
    }
    if (Number.isFinite(deadline) && Date.now() > deadline) return { outcome: 'timed_out' };
    if (watch && (await watch()) !== 'unchanged') {
      // Stale: the card's Allow would approve settings that are no longer there.
      gateway.deny?.(ticket.approvalId, 'The folder changed again. Review the new version.');
      logger.info('[FolderConfig] Changed again while the card was open', {
        agentId: request.agentId,
      });
      return { outcome: 'changed' };
    }
    await _internal.sleep(_internal.pollIntervalMs);
  }
}
