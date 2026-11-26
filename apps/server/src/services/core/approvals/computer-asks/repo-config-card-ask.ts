/**
 * The card that asks a person before a repo's changed hooks, a worktree's local
 * settings or a changed `.mcp.json` run (DOR-3298), its wait, and the decision
 * it records, on the space side (spec `computer-side-starts-alone` §5.7).
 *
 * The same token-and-retry card the agent-home pin raises
 * (`folder-config-card-ask.ts`), through the same approval gateway. The
 * detail is the diff against the default branch (the local settings' content,
 * which has no default branch), which the computer reads, so a person approves
 * what they read. The answer is bound to that content's digest: a yes can never
 * be spent on anything else, and it is recorded in `repo-decisions.ts` before
 * the computer hears it.
 *
 * ## While the card is open
 *
 * The wait has the computer re-read the worktree on every poll. If the content
 * changed, the card is withdrawn with "The hook changed again." and the
 * computer asks about the new content. If it went back to the default branch's
 * (byte for byte for a script), the card is withdrawn and the computer's
 * Activity line says the setting runs again. The approval store has no
 * "withdraw" of its own, so withdrawing is a no with that reason, which the
 * wait does not record as a person's no.
 *
 * @module services/core/approvals/computer-asks/repo-config-card-ask
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type {
  AskAnswer,
  AskWatch,
  RepoConfigKind,
  RepoConfigRequest,
} from '@dorkos/shared/computer-asks';
import { worktreeName } from '@dorkos/shared/consent-entries';
import {
  hashApprovalInput,
  quoteSummaryValue,
  redactSecretsInText,
  storableDetail,
} from '@dorkos/shared/approval-text';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import type { ApprovalBinding } from '../approval-service.js';
import { logger } from '../../../../lib/logger.js';
import type { FolderAllowApprovalGateway } from './folder-allows-card-ask.js';
import { recordRepoConfigApproval, recordRepoConfigRefusal } from './repo-decisions.js';

/** The card for each kind. Not capabilities anyone can invoke. */
export const REPO_CONFIG_CAPABILITY_IDS: Record<RepoConfigKind, string> = {
  hooks: 'runtime.apply_repo_hooks',
  local: 'runtime.apply_repo_local_settings',
  mcpJson: 'runtime.apply_repo_mcp',
};

/**
 * The hooks card's sibling for a change that only widens what agents can run:
 * a skill, subagent or command, never a hook or a setting (DOR-3359). Its own
 * id so its badge can say so; the stored yes is the hooks kind's either way.
 */
export const REPO_TOOLS_CAPABILITY_ID = 'runtime.apply_repo_tools';

/**
 * Whether an id is one of the repo-pin cards. Only the launch raises these:
 * neither is in the capability registry, so no tool, route or
 * `request_permission` can name one, and the test seed route refuses them.
 *
 * @param capabilityId - The id to check.
 */
export function isRepoPinCapabilityId(capabilityId: string): boolean {
  return (
    capabilityId === REPO_CONFIG_CAPABILITY_IDS.hooks || capabilityId === REPO_TOOLS_CAPABILITY_ID
  );
}

/**
 * Each card's fallback title. A repo-pin card always carries its own title
 * ({@link repoConfigTitle}); the summary names what changed.
 */
const TITLES: Record<RepoConfigKind, string> = {
  hooks: 'Run an edited repo hook',
  local: "Load a worktree's local settings",
  mcpJson: "Start a repo's changed MCP servers",
};

/** What a yes on a repo-pin card does, for its badge in place of "Cannot be undone". */
const CONSEQUENCES = {
  runsCode: 'Runs code on this Mac',
  widens: 'Widens what agents can run',
} as const;

/**
 * Describe a repo settings card's capability. `destructive`, as the hook card
 * is: a yes lets code run unattended. The repo-pin cards also name what a yes
 * does; the local-settings and MCP cards keep the tier's own label.
 *
 * @param capabilityId - The id `ApprovalService` is resolving.
 */
export function describeRepoConfigCapability(capabilityId: string):
  | {
      title: string;
      tier: CapabilityTier;
      consequence?: string;
      titledPerRequest?: true;
    }
  | undefined {
  // Both repo-pin ids carry the same policy: destructive, titled only by
  // repoConfigTitle's fixed templates, never an area (so never Always allow).
  if (capabilityId === REPO_TOOLS_CAPABILITY_ID) {
    return {
      title: 'Allow a changed repo skill',
      tier: 'destructive',
      consequence: CONSEQUENCES.widens,
      titledPerRequest: true,
    };
  }
  const kind = (Object.keys(REPO_CONFIG_CAPABILITY_IDS) as RepoConfigKind[]).find(
    (k) => REPO_CONFIG_CAPABILITY_IDS[k] === capabilityId
  );
  if (!kind) return undefined;
  return kind === 'hooks'
    ? {
        title: TITLES.hooks,
        tier: 'destructive',
        consequence: CONSEQUENCES.runsCode,
        titledPerRequest: true,
      }
    : { title: TITLES[kind], tier: 'destructive' };
}

/** Longest worktree name a card title shows, in characters (designer, 10:16 Oct 27). */
const TITLE_WORKTREE_MAX = 40;

/**
 * A worktree's name as a card title quotes it. Sanitized first, then cut
 * (Security): secrets redacted, invisible and control characters stripped,
 * double quotes turned single, and only then shortened to
 * {@link TITLE_WORKTREE_MAX} characters, counted as code points so a cut
 * never splits one. The cut is in the middle, because the start and the end
 * are what tell two worktrees apart; the diff header keeps the full name.
 *
 * @param cwd - The worktree's folder.
 */
export function worktreeTitleName(cwd: string): string {
  const clean = sanitizeIdentity(redactSecretsInText(worktreeName(cwd)), Infinity) ?? 'worktree';
  const points = Array.from(clean.replace(/["“”]/g, "'"));
  if (points.length <= TITLE_WORKTREE_MAX) return `"${points.join('')}"`;
  const head = Math.ceil((TITLE_WORKTREE_MAX - 1) / 2);
  const tail = TITLE_WORKTREE_MAX - 1 - head;
  return `"${points.slice(0, head).join('')}…${points.slice(-tail).join('')}"`;
}

/** What one changed repo file is, as a card title names it. */
type RepoFileKind = 'hook' | 'setting' | 'skill' | 'subagent' | 'command';

/**
 * What one changed file is, by where it sits under `.claude` or `.agents`.
 * Anything else is a script a hook runs, so a hook.
 *
 * @param rel - The file's repo-relative path.
 */
function repoFileKind(rel: string): RepoFileKind {
  const parts = rel.split('/');
  const at = Math.max(parts.lastIndexOf('.claude'), parts.lastIndexOf('.agents'));
  const first = at === -1 ? undefined : parts[at + 1];
  if (first === 'settings.json') return 'setting';
  if (first === 'skills') return 'skill';
  if (first === 'agents') return 'subagent';
  if (first === 'commands') return 'command';
  return 'hook';
}

/** Whether a yes on this card only widens tools: no hook, no setting, no trust. */
function onlyWidens(request: RepoConfigRequest): boolean {
  if (request.kind !== 'hooks' || request.trust || request.names.length === 0) return false;
  return request.names.every((name) => {
    const kind = repoFileKind(name);
    return kind === 'skill' || kind === 'subagent' || kind === 'command';
  });
}

/**
 * The capability a card is raised under, which decides its badge.
 *
 * @param request - The setting and what changed.
 */
export function repoConfigCapabilityId(request: RepoConfigRequest): string {
  return onlyWidens(request) ? REPO_TOOLS_CAPABILITY_ID : REPO_CONFIG_CAPABILITY_IDS[request.kind];
}

/**
 * A repo-pin card's title: what Allow does (designer copy, DOR-3359). The
 * local-settings and MCP cards keep their capability's title.
 *
 * @param request - The setting and what changed.
 */
export function repoConfigTitle(request: RepoConfigRequest): string | undefined {
  if (request.kind !== 'hooks') return undefined;
  if (request.trust) return "Trust this repo's hooks and skills?";
  const wt = worktreeTitleName(request.cwd);
  return request.names.length === 1
    ? `Allow a changed ${repoFileKind(request.names[0]!)} in ${wt}?`
    : `Allow ${request.names.length} changed repo files in ${wt}?`;
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
  const lines: string[] = [];
  const reason = request.trust?.reason;
  if (request.trust) {
    // A trust card is about the repo's default branch, never an edit here.
    lines.push(TRUST_REASONS[reason ?? 'moved']);
    lines.push(
      reason === 'hooks-moved'
        ? 'Approving trusts the new version, shown here.'
        : "Approving trusts its default branch's hooks, shown here."
    );
  } else if (request.kind === 'hooks') {
    // Where the change came from is this worktree (its branch or its edits),
    // never necessarily an agent; what it is comes from the file's place. The
    // title names the worktree (DOR-3359).
    lines.push(
      request.names.length === 1
        ? `${quoteSummaryValue(request.names[0])} differs from the default branch. ${whatItSets(request.names[0]!)}`
        : `${request.names.length} files here differ from the default branch.`
    );
    lines.push("Until you approve it, this repo's hooks, skills and commands stay off here.");
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
        : 'Matching the default branch again also turns them back on.'
    );
  }
  return lines.join(' ');
}

/**
 * What one changed file sets, by where it sits: a skill or subagent's
 * frontmatter widens tools, it is not a hook.
 */
function whatItSets(rel: string): string {
  const parts = rel.split('/');
  const rest = parts.slice(parts.lastIndexOf('.claude') + 1);
  if (parts.includes('.claude') && rest[0] === 'hooks') return "It's a hook script.";
  if (rest[0] === 'settings.json') return 'It sets what runs on tool calls.';
  if (rest[0] === 'skills') return 'It changes which tools or hooks a skill has.';
  if (rest[0] === 'agents') return 'It changes what a subagent can do.';
  // Designer, #dorkos 11:04 Oct 27.
  if (rest[0] === 'commands') return 'It changes what a command can run.';
  return "It's a script a hook runs.";
}

/** Why a repo's default branch waits for a person, as a trust card says it. */
const TRUST_REASONS: Record<string, string> = {
  'first-seen': "DorkOS hasn't seen this repo before.",
  // The ref is whatever the repo says its default branch is, which an agent can move (S9).
  'hooks-moved': 'The commit this repo calls its default branch changed its hooks.',
  moved: "This repo's default branch moved somewhere DorkOS can't confirm.",
};

/** Seams the wait loop uses, injectable so tests do not sleep in real time. */
export const _internal = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
  pollIntervalMs: 5_000,
};

/** The approval primitive, with the no it uses to withdraw a card. */
export type RepoConfigApprovalGateway = FolderAllowApprovalGateway & {
  deny?: (approvalId: string, reason?: string) => unknown;
};

/**
 * Ask a person whether this content may run, wait for the answer, and record
 * it. Fails closed on everything but an explicit yes; only an explicit no is
 * recorded. Content that went back (`undone`) or changed again (`changed`)
 * while the card was open takes the card down, recording nothing.
 *
 * @param gateway - The approval primitive.
 * @param request - The setting and what changed.
 * @param watch - Has the computer read the worktree again, between presentations.
 * @returns The answer; only `granted` lets the content run.
 */
export async function raiseRepoConfigCard(
  gateway: RepoConfigApprovalGateway,
  request: RepoConfigRequest,
  watch?: AskWatch
): Promise<AskAnswer> {
  const title = repoConfigTitle(request);
  const binding: ApprovalBinding = {
    capabilityId: repoConfigCapabilityId(request),
    // Content only, as the stored entry is: the yes is for exactly this diff.
    inputHash: hashApprovalInput({ kind: request.kind, digest: request.digest }),
  };
  const log = { kind: request.kind, cwd: request.cwd, names: request.names };
  const ticket = gateway.request({
    ...binding,
    ...(title ? { title } : {}),
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
      return { outcome: 'granted' };
    }
    if (result.outcome !== 'pending') {
      if (result.outcome === 'denied') recordRepoConfigRefusal(request.kind, request.digest);
      logger.info('[RepoConfig] Not allowed', { ...log, outcome: result.outcome });
      return { outcome: result.outcome };
    }
    if (Number.isFinite(deadline) && Date.now() > deadline) return { outcome: 'timed_out' };
    const now = watch ? await watch() : 'unchanged';
    if (now === 'undone') {
      // Undone: it matches the default branch again. Nothing left to approve.
      withdraw(`${capitalised(request.kind)} running again in ${worktreeName(request.cwd)}.`);
      logger.info('[RepoConfig] Undone while the card was open', log);
      return { outcome: 'undone' };
    }
    if (now === 'changed') {
      // Stale: the card's Allow would approve content that is no longer there.
      withdraw(
        request.kind === 'hooks'
          ? 'The hook changed again. Review the new version.'
          : 'The file changed again. Review the new version.'
      );
      logger.info('[RepoConfig] Changed again while the card was open', log);
      return { outcome: 'changed' };
    }
    await _internal.sleep(_internal.pollIntervalMs);
  }
}

/** "Repo hooks", "Local settings", "Repo MCP servers". */
function capitalised(kind: RepoConfigKind): string {
  return { hooks: 'Repo hooks', local: 'Local settings', mcpJson: 'Repo MCP servers' }[kind];
}
