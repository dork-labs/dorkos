/**
 * Ask a person before an agent's changed folder settings run (DOR-3068).
 *
 * The same token-and-retry card the folder allow list raises
 * (`folder-allow-approval.ts`), through the same approval gateway. The card
 * names the agent and which of its settings changed, never their contents; the
 * answer is recorded in `folder-config-consent.ts` against the exact digests
 * the card was raised for.
 *
 * Fire-and-forget from the launch: a turn never waits on the card. Until a
 * person says yes, the turn runs without the changed parts.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-config-approval
 */
import path from 'node:path';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { ApprovalBinding } from '../../../core/approvals/approval-service.js';
import { hashApprovalInput, quoteSummaryValue } from '../../../core/approvals/index.js';
import { logger } from '../../../../lib/logger.js';
import type { FolderAllowApprovalGateway } from './folder-allow-approval.js';
import {
  folderConfigEntry,
  isFolderConfigApproved,
  isFolderConfigRefused,
  recordFolderConfigApproval,
  recordFolderConfigRefusal,
  type FolderConfigRequest,
} from './folder-config-consent.js';
import type { FolderConfigPart } from './folder-config-pin.js';

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

/** Cards on screen now, so a second turn does not raise a second card. */
const askingNow = new Set<string>();

/** Seams the wait loop uses, injectable so tests do not sleep in real time. */
export const _internal = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
  pollIntervalMs: 5_000,
  forgetOpenCards: (): void => {
    askingNow.clear();
  },
};

/**
 * Whether a card for this state would be new information: not already
 * decided, and not already on screen.
 *
 * @param request - The agent and the state of its settings.
 */
export function mayAskAboutFolderConfig(request: FolderConfigRequest): boolean {
  return (
    request.changed.length > 0 &&
    !askingNow.has(folderConfigEntry(request)) &&
    !isFolderConfigApproved(request) &&
    !isFolderConfigRefused(request)
  );
}

/**
 * Ask a person whether this state of the agent's settings may run, wait for
 * the answer, and record it. Fails closed on everything but an explicit yes;
 * only an explicit no is recorded, so a missed card asks again on a later turn.
 *
 * @param gateway - The approval primitive (the one folder allow lists use).
 * @param request - The agent and the state of its settings.
 * @returns True only when a person granted it.
 */
export async function askForFolderConfig(
  gateway: FolderAllowApprovalGateway,
  request: FolderConfigRequest
): Promise<boolean> {
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
  const entry = folderConfigEntry(request);
  askingNow.add(entry);
  try {
    const ticket = gateway.request({
      ...binding,
      summary: summariseFolderConfig(request),
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
        return true;
      }
      if (result.outcome !== 'pending') {
        if (result.outcome === 'denied') recordFolderConfigRefusal(request);
        logger.info('[FolderConfig] Not allowed', {
          agentId: request.agentId,
          outcome: result.outcome,
        });
        return false;
      }
      if (Number.isFinite(deadline) && Date.now() > deadline) return false;
      await _internal.sleep(_internal.pollIntervalMs);
    }
  } finally {
    askingNow.delete(entry);
  }
}
