/**
 * Which account a scheduled run starts on when its own is out of usage or
 * signed out (DOR-5097).
 *
 * A run starts on its task's `account`, else its agent's, else the default,
 * through the launch ladder. When that account is out of usage, or a turn last
 * saw it signed out, every run would fail until the reset, which can be days
 * away. So before a run starts a conversation, DorkOS asks where it should run:
 *
 * - **stay**: the account has room, or nobody knows yet. Run there.
 * - **move**: it is out or signed out, and another account can take the work.
 *   The run starts there, and its history says which account and why.
 * - **pinned**: the task runs only on its own account. The run fails with a
 *   plain sentence instead of moving.
 *
 * The pick is the one a room seat makes when its account runs out
 * (`pickReseatAccount` over core's ranking for the folder's project): never
 * DorkOS credits, never an account a person kept out of automatic moves, never
 * one not allowed in the project or not signed in. On top of that, never the
 * main sign-in: an automatic pick never puts agent work there (spec
 * `claude-account-fleet` D5, DOR-3145). With nowhere to go, the run starts on
 * its own account as before, and fails there as it always did.
 *
 * Only Claude Code runs carry an account, and only a run that starts a
 * conversation picks one: a resumed sticky conversation keeps its account.
 * Each account is its own Claude folder with its own settings (its user
 * CLAUDE.md, MCP servers and sign-in), so a moved run reads that folder's.
 *
 * This automatic fallback runs on every trust preset, Careful included: it
 * changes no approved setting, only where one run starts.
 *
 * @module services/tasks/session/run-account-fallback
 */
import { readManifest } from '@dorkos/shared/manifest';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { TaskRunAccountMove } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { projectOfFolder } from '../../core/usage/account-eligibility.js';
import {
  coreRanking,
  formatShortLocalTime,
  type RankedAccount,
} from '../../core/usage/account-ranking.js';
import { isMainAccount, pickReseatAccount } from '../../rooms/reseat/reseat-accounts.js';
import { resolveLaunchAccountRoot } from '../../runtimes/claude-code/claude-config-dir.js';

/** Where a run starts. */
export type RunAccountDecision =
  | { kind: 'stay' }
  | { kind: 'move'; move: TaskRunAccountMove }
  | { kind: 'pinned'; message: string };

/** What a decision reads: the account the run would start on, and where it may go. */
export interface RunAccountWorld {
  /** The account id the launch ladder would pick for this run. */
  accountId: string;
  /** Core's ranking of Claude Code accounts for the run's project, best first. */
  ranking: readonly RankedAccount[];
}

/** An account as a run's history names it. */
function named(row: RankedAccount): TaskRunAccountMove['from'] {
  return { id: row.id, label: row.label };
}

/** The sentence a pinned run fails with: the account, why it cannot run, and the pin. */
function pinnedMessage(own: RankedAccount, reason: TaskRunAccountMove['reason']): string {
  const name = own.label ?? own.id;
  const resetsAt = own.usage.limit?.resetsAt;
  const until = resetsAt ? formatShortLocalTime(resetsAt) : null;
  const why =
    reason === 'signed-out'
      ? `${name} is signed out.`
      : until
        ? `${name} is out of usage until ${until}.`
        : `${name} is out of usage.`;
  return `${why} This task runs only on ${name}.`;
}

/**
 * Decide where a run starts. Pure.
 *
 * @param world - The account the run would start on and core's ranking.
 * @param pinned - The task runs only on its own account.
 */
export function decideRunAccount(world: RunAccountWorld, pinned: boolean): RunAccountDecision {
  const own = world.ranking.find((row) => row.id === world.accountId);
  // An account core does not rank (not routable here, or no usage store): nothing to judge by.
  if (!own) return { kind: 'stay' };
  const reason: TaskRunAccountMove['reason'] | null =
    own.usage.state === 'limited' ? 'limited' : own.signedOut === true ? 'signed-out' : null;
  if (reason === null) return { kind: 'stay' };
  if (pinned) return { kind: 'pinned', message: pinnedMessage(own, reason) };
  const pick = pickReseatAccount(
    world.ranking.filter((row) => !isMainAccount(row)),
    { runtime: 'claude-code', currentAccountId: own.id }
  );
  if (pick.kind === 'none') return { kind: 'stay' };
  return { kind: 'move', move: { from: named(own), to: named(pick.account), reason } };
}

/** What the live reader is asked: the run's account hint, its agent and its folder. */
export interface RunAccountQuestion {
  /** The task's own account, as the run would hint it. */
  accountHint: string | undefined;
  /** The agent's home, when the task has one. */
  agentPath: string | undefined;
  /** The folder the run starts in. */
  cwd: string;
}

/** How a run's account and its alternatives are read; a test hands in its own. */
export type RunAccountReader = (question: RunAccountQuestion) => Promise<RunAccountWorld | null>;

/**
 * The live reader: the launch ladder's own pick for this run (the task's
 * account, else the agent's, else the default, kept to the project's
 * accounts), and core's ranking for the project. `null` when the ladder
 * refuses (the run's own account check says why) or the run would use DorkOS
 * credits, which never move onto a person's own sign-in.
 *
 * @param question - The run's account hint, agent and folder.
 */
export const readRunAccountWorld: RunAccountReader = async (question) => {
  const project = await projectOfFolder(question.cwd);
  const manifest = question.agentPath ? await readManifest(question.agentPath) : null;
  const resolved = resolveLaunchAccountRoot({
    hintId: question.accountHint,
    agentAccountId: manifest?.account,
    agentId: manifest?.id,
    project,
  });
  if (!resolved.ok || resolved.accountId === CREDITS_ACCOUNT_ID) return null;
  return { accountId: resolved.accountId, ranking: coreRanking('claude-code', project) };
};

/**
 * Where a run starts, read live. Never throws: anything it cannot read answers
 * `stay`, so a run starts as it did before this existed.
 *
 * @param question - The run's account hint, agent and folder.
 * @param pinned - The task runs only on its own account.
 * @param read - Where the account and its alternatives are read.
 */
export async function runAccountDecision(
  question: RunAccountQuestion,
  pinned: boolean,
  read: RunAccountReader = readRunAccountWorld
): Promise<RunAccountDecision> {
  try {
    const world = await read(question);
    return world === null ? { kind: 'stay' } : decideRunAccount(world, pinned);
  } catch (err) {
    logger.warn('[tasks] could not check the run’s account; starting it where it is', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'stay' };
  }
}
