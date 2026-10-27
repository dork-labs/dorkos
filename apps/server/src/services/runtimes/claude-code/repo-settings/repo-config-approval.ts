/**
 * Ask a person before a repo's changed hooks, a worktree's local settings or
 * a changed `.mcp.json` run (DOR-3298).
 *
 * The same token-and-retry card the agent-home pin raises
 * (`folder-config-approval.ts`), through the same approval gateway. The
 * detail is the diff against the default branch (the local settings' content,
 * which has no default branch), so a person approves what they read. The
 * answer is bound to that content's digest: a yes can never be spent on
 * anything else.
 *
 * ## While the card is open
 *
 * The wait re-reads the worktree on every poll. If the content changed, the
 * card is withdrawn with "The hook changed again." and a new card asks about
 * the new content. If it went back to the default branch's (byte for byte for
 * a script), the card is withdrawn and the Activity feed says the setting runs
 * again. The approval store has no "withdraw" of its own, so withdrawing is a
 * no with that reason, which the wait does not record as a person's no.
 *
 * Fire-and-forget from the launch: a turn never waits on the card.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-config-approval
 */
import path from 'node:path';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { ApprovalBinding } from '../../../core/approvals/approval-service.js';
import { hashApprovalInput, quoteSummaryValue } from '../../../core/approvals/index.js';
import { storableDetail } from '../../../core/approvals/approval-storable.js';
import { logger } from '../../../../lib/logger.js';
import type { FolderAllowApprovalGateway } from '../folder-settings/folder-allow-approval.js';
import { noteRunning } from './repo-config-activity.js';
import type { UntrustedReason } from './repo-baseline.js';
import {
  isRepoConfigApproved,
  isRepoConfigRefused,
  recordRepoConfigApproval,
  recordRepoConfigRefusal,
  repoConfigEntry,
  type RecordedBaseline,
  type RepoConfigKind,
} from './repo-config-consent.js';

/** The card for each kind. Not capabilities anyone can invoke. */
export const REPO_CONFIG_CAPABILITY_IDS: Record<RepoConfigKind, string> = {
  hooks: 'runtime.apply_repo_hooks',
  local: 'runtime.apply_repo_local_settings',
  mcpJson: 'runtime.apply_repo_mcp',
};

/** Each card's title; the summary names the worktree and what changed. */
const TITLES: Record<RepoConfigKind, string> = {
  hooks: 'Run an edited repo hook',
  local: "Load a worktree's local settings",
  mcpJson: "Start a repo's changed MCP servers",
};

/**
 * Describe a repo settings card's capability. `destructive`, as the hook card
 * is: a yes lets code run unattended.
 *
 * @param capabilityId - The id `ApprovalService` is resolving.
 */
export function describeRepoConfigCapability(
  capabilityId: string
): { title: string; tier: CapabilityTier } | undefined {
  const kind = (Object.keys(REPO_CONFIG_CAPABILITY_IDS) as RepoConfigKind[]).find(
    (k) => REPO_CONFIG_CAPABILITY_IDS[k] === capabilityId
  );
  return kind ? { title: TITLES[kind], tier: 'destructive' } : undefined;
}

/** One repo setting, as a person is asked about it. */
export interface RepoConfigRequest {
  /** Which setting. */
  kind: RepoConfigKind;
  /** The content digest the card binds to. */
  digest: string;
  /** What changed, by name: files, or settings keys for local settings. */
  names: string[];
  /** The diff or content the card shows. */
  detail: string;
  /** The worktree's folder. */
  cwd: string;
  /** The agent the turn runs as, if any. */
  agentName: string | undefined;
  /** Set when the default branch could not be confirmed: a yes trusts it from now on. */
  trust?: { commonDir: string; baseline: RecordedBaseline; reason?: UntrustedReason };
}

/**
 * A worktree's name, as a card and a line say it: its folder's name.
 *
 * @param cwd - The worktree's folder.
 */
export function worktreeName(cwd: string): string {
  return path.basename(path.resolve(cwd)) || cwd;
}

/**
 * The sentences on the card (designer copy for hooks). Never the content: that
 * is the detail.
 *
 * @param request - The setting and what changed.
 */
export function summariseRepoConfig(request: RepoConfigRequest): string {
  const wt = quoteSummaryValue(worktreeName(request.cwd));
  const agent = request.agentName ? quoteSummaryValue(request.agentName) : undefined;
  const who = agent ?? 'An agent';
  const lines: string[] = [];
  const reason = request.trust?.reason;
  if (request.trust) {
    // A trust card is about the repo's default branch, never an edit here.
    lines.push(`Repo hooks paused in ${wt}.`);
    lines.push(TRUST_REASONS[reason ?? 'moved']);
    lines.push(
      reason === 'hooks-moved'
        ? 'Approving trusts the new version, shown here.'
        : "Approving trusts its default branch's hooks, shown here."
    );
  } else if (request.kind === 'hooks') {
    lines.push(`Repo hooks paused in ${wt}.`);
    lines.push(
      request.names.length === 1
        ? `${who} edited ${quoteSummaryValue(request.names[0])}, a hook that runs on every tool call.`
        : `${who} changed ${request.names.length} hook files.`
    );
    lines.push("Until you approve it, none of this repo's hooks run in this worktree.");
  } else if (request.kind === 'local') {
    lines.push(`Local settings paused in ${wt}.`);
    lines.push(`Its settings.local.json sets ${request.names.join(', ')}, which nobody reviewed.`);
    lines.push('That file stays off here until you approve it.');
  } else {
    lines.push(`Repo MCP servers paused in ${wt}.`);
    lines.push(
      `${request.names.map(quoteSummaryValue).join(', ')} differs from the default branch.`
    );
    lines.push("Until you approve it, only the default branch's servers start here.");
  }
  if (agent) lines.push(`Your permission settings for ${agent} still apply.`);
  if (storableDetail(request.detail) !== request.detail) {
    lines.push('Part of the change is too long to show here.');
  }
  // Only an edit in the worktree can be undone there.
  if (!request.trust) {
    lines.push(
      request.kind === 'local'
        ? 'Deleting the file also ends the pause.'
        : 'Undoing the edit also turns them back on.'
    );
  }
  return lines.join(' ');
}

/** Why a repo's default branch waits for a person, as a trust card says it. */
const TRUST_REASONS: Record<string, string> = {
  'first-seen': "DorkOS hasn't seen this repo before.",
  'hooks-moved': "This repo's default branch changed its hooks.",
  moved: "This repo's default branch moved somewhere DorkOS can't confirm.",
};

/** Cards on screen now, by entry, so a second turn does not raise a second card. */
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
 * Whether a card for this content would be new information: approvable, not
 * already decided, and not already on screen.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 */
export function mayAskAboutRepoConfig(kind: RepoConfigKind, digest: string): boolean {
  return (
    !askingNow.has(repoConfigEntry(kind, digest)) &&
    !isRepoConfigApproved(kind, digest) &&
    !isRepoConfigRefused(kind, digest)
  );
}

/** The approval primitive, with the no it uses to withdraw a card. */
export type RepoConfigApprovalGateway = FolderAllowApprovalGateway & {
  deny?: (approvalId: string, reason?: string) => unknown;
};

/** What the worktree holds now, re-read while the card is open. */
export type RepoConfigReread = () => Promise<'clean' | { digest: string } | 'unknown'>;

/**
 * Ask a person whether this content may run, wait for the answer, and record
 * it. Fails closed on everything but an explicit yes; only an explicit no is
 * recorded.
 *
 * @param gateway - The approval primitive.
 * @param request - The setting and what changed.
 * @param reread - Reads the worktree again, for the stale and undone states.
 * @param onChanged - Called when the content changed under the card, to ask again.
 * @returns True only when a person granted it.
 */
export async function askForRepoConfig(
  gateway: RepoConfigApprovalGateway,
  request: RepoConfigRequest,
  reread: RepoConfigReread,
  onChanged: () => void
): Promise<boolean> {
  const binding: ApprovalBinding = {
    capabilityId: REPO_CONFIG_CAPABILITY_IDS[request.kind],
    // Content only, as the stored entry is: the yes is for exactly this diff.
    inputHash: hashApprovalInput({ kind: request.kind, digest: request.digest }),
  };
  const entry = repoConfigEntry(request.kind, request.digest);
  askingNow.add(entry);
  const log = { kind: request.kind, cwd: request.cwd, names: request.names };
  try {
    const ticket = gateway.request({
      ...binding,
      summary: summariseRepoConfig(request),
      detail: request.detail,
      ...(request.agentName ? { requestedBy: request.agentName } : {}),
    });
    logger.info('[RepoConfig] Waiting on a person to allow changed repo settings', {
      ...log,
      approvalId: ticket.approvalId,
    });
    const deadline = new Date(ticket.expiresAt).getTime();
    const withdraw = (reason: string) => gateway.deny?.(ticket.approvalId, reason);
    for (;;) {
      const result = gateway.consume(ticket.token, binding);
      if (result.outcome === 'granted') {
        recordRepoConfigApproval(request.kind, request.digest, request.trust);
        logger.info('[RepoConfig] Allowed', log);
        return true;
      }
      if (result.outcome !== 'pending') {
        if (result.outcome === 'denied') recordRepoConfigRefusal(request.kind, request.digest);
        logger.info('[RepoConfig] Not allowed', { ...log, outcome: result.outcome });
        return false;
      }
      if (Number.isFinite(deadline) && Date.now() > deadline) return false;
      const now = await reread();
      if (now === 'clean') {
        // Undone: it matches the default branch again. Nothing left to approve.
        withdraw(`${capitalised(request.kind)} running again in ${worktreeName(request.cwd)}.`);
        noteRunning(request.kind, request.cwd, worktreeName(request.cwd));
        logger.info('[RepoConfig] Undone while the card was open', log);
        return false;
      }
      if (now !== 'unknown' && now.digest !== request.digest) {
        // Stale: the card's Allow would approve content that is no longer there.
        withdraw(
          request.kind === 'hooks'
            ? 'The hook changed again. Review the new version.'
            : 'The file changed again. Review the new version.'
        );
        logger.info('[RepoConfig] Changed again while the card was open', log);
        askingNow.delete(entry);
        onChanged();
        return false;
      }
      await _internal.sleep(_internal.pollIntervalMs);
    }
  } finally {
    askingNow.delete(entry);
  }
}

/** "Repo hooks", "Local settings", "Repo MCP servers". */
function capitalised(kind: RepoConfigKind): string {
  return { hooks: 'Repo hooks', local: 'Local settings', mcpJson: 'Repo MCP servers' }[kind];
}
