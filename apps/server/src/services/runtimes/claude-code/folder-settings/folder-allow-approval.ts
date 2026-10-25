/**
 * Ask a person before an agent's own folder allow list applies (DOR-3039).
 *
 * The same token-and-retry card the hook projection raises
 * (`services/harness/hook-approval.ts`), for the same kind of decision: a file
 * the agent can edit wants to widen what runs without asking. The card names
 * the agent and every rule; the answer is recorded in `folder-allow-consent.ts`
 * against a digest of exactly those rules.
 *
 * Fire-and-forget from the launch: a turn never waits on the card. Until a
 * person says yes the list does not apply, and the turn runs as it always did.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-allow-approval
 */
import path from 'node:path';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type {
  ApprovalBinding,
  ApprovalConsumeResult,
  ApprovalRequestInput,
  ApprovalTicket,
} from '../../../core/approvals/approval-service.js';
import { hashApprovalInput, quoteSummaryValue } from '../../../core/approvals/index.js';
import { storableSummary } from '../../../core/approvals/approval-storable.js';
import { logger } from '../../../../lib/logger.js';
import {
  folderAllowEntry,
  isFolderAllowListApproved,
  isFolderAllowListRefused,
  recordFolderAllowApproval,
  recordFolderAllowRefusal,
  type FolderAllowRequest,
} from './folder-allow-consent.js';

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

/** The slice of `ApprovalService` this gate uses. */
export interface FolderAllowApprovalGateway {
  /** Record a pending approval and return the one-time token to retry with. */
  request(input: ApprovalRequestInput): ApprovalTicket;
  /** Present the token for the action it was granted for. */
  consume(token: string, binding: ApprovalBinding): ApprovalConsumeResult;
}

/**
 * The approval primitive the launch raises cards through. Set once at boot
 * (the runtime starts before the approval service exists); until then a list
 * nobody approved stays unapplied and nobody is asked.
 */
let bootGateway: FolderAllowApprovalGateway | null = null;

/**
 * Hand the launch the approval primitive.
 *
 * @param next - The approval service, or `null` to stop asking (tests).
 */
export function setFolderAllowApprovalGateway(next: FolderAllowApprovalGateway | null): void {
  bootGateway = next;
}

/** The approval primitive set at boot, if any. */
export function folderAllowApprovalGateway(): FolderAllowApprovalGateway | null {
  return bootGateway;
}

/**
 * One rule for the card, whole, quoted so it cannot fake card text. Never
 * shortened: `judgeAllowRule` keeps only rules short enough to show in full.
 */
function renderRuleForCard(rule: string): string {
  return JSON.stringify(rule);
}

/**
 * Whether the card would show this list exactly as written. The approval store
 * caps a summary's length and hides anything shaped like a secret; a list whose
 * card lost a word to either would be approved by a person who never saw all
 * of it, so it is never asked about (DOR-3039 review).
 *
 * @param request - The list a card would ask about.
 */
export function cardShowsWholeList(request: FolderAllowRequest): boolean {
  const summary = summariseFolderAllows(request);
  return storableSummary(summary) === summary;
}

/** `1 command`, `2 commands`. */
function commands(count: number): string {
  return `${count} command${count === 1 ? '' : 's'}`;
}

/**
 * The sentence on the card (copy signed off by designer). A new list names
 * every rule; a changed one names what was added and removed. Rules are shown
 * exactly as written, quoted so a rule cannot fake card text.
 *
 * @param request - The agent, its rules, and the rules behind its last yes.
 */
export function summariseFolderAllows(request: FolderAllowRequest): string {
  const name = quoteSummaryValue(request.agentName);
  const list = (rules: readonly string[]) => rules.map(renderRuleForCard).join(', ');
  const parts: string[] = [];
  const previous = request.previousRules;
  if (previous) {
    const added = request.rules.filter((rule) => !previous.includes(rule));
    const removed = previous.filter((rule) => !request.rules.includes(rule));
    parts.push(`${name} changed the commands it can run without asking.`);
    if (added.length > 0) parts.push(`Added: ${list(added)}.`);
    if (removed.length > 0) parts.push(`Removed: ${list(removed)}.`);
  } else {
    parts.push(
      `Let ${name} run ${commands(request.rules.length)} without asking, as listed in its folder: ${list(request.rules)}.`
    );
  }
  parts.push('Applies from its next turn.');
  const dropped = request.dropped ?? 0;
  if (dropped > 0) {
    parts.push(
      `${dropped} rule${dropped === 1 ? '' : 's'} left out: DorkOS never applies wildcards or rules for its own tools.`
    );
  }
  return parts.join(' ');
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
 * Whether a card for this list would be new information: not already decided,
 * and not already on screen.
 *
 * @param request - The agent and its rules.
 */
export function mayAskAboutFolderAllows(request: FolderAllowRequest): boolean {
  return (
    request.rules.length > 0 &&
    !askingNow.has(folderAllowEntry(request)) &&
    !isFolderAllowListApproved(request) &&
    !isFolderAllowListRefused(request)
  );
}

/**
 * Ask a person whether this agent's list may apply, wait for the answer, and
 * record it. Fails closed on everything but an explicit yes; only an explicit
 * no is recorded, so a missed card asks again on a later turn.
 *
 * @param gateway - The approval primitive.
 * @param request - The agent and its rules.
 * @returns True only when a person granted it.
 */
export async function askForFolderAllows(
  gateway: FolderAllowApprovalGateway,
  request: FolderAllowRequest
): Promise<boolean> {
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
  const entry = folderAllowEntry(request);
  askingNow.add(entry);
  try {
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
        return true;
      }
      if (result.outcome !== 'pending') {
        if (result.outcome === 'denied') recordFolderAllowRefusal(request);
        logger.info('[FolderAllows] Not allowed', {
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
