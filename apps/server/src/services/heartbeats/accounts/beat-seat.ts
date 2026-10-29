/**
 * Which account a beat turn runs on, so beats keep running when an account runs
 * out (they used to stall overnight there).
 *
 * A beat chat is pinned to the account its first turn ran on, like any chat.
 * When that account is out of usage, or nearly out, every beat that day would
 * hit the same wall and end without `end_beat`. So before a beat turn starts,
 * and once more after one ran into a limit, the runner asks where it should run:
 *
 * - **stay** — the chat's account has room (or nobody knows yet): run there.
 * - **move** — it is out or nearly out, and another account can take the work:
 *   start a fresh beat chat on that one. A beat chat holds no conversation the
 *   next beat needs (every beat carries its whole prompt), so nothing is carried.
 * - **wait** — no account can take it: skip the beat instead of burning it, so
 *   what it gathered is looked at again once an account is usable.
 *
 * The pick is the same one a room seat makes (`reseat-accounts.ts`): core's own
 * ranking for the folder's project, never DorkOS credits, never an account a
 * person kept out of automatic moves. A fresh beat chat on a new day starts on
 * the agent's own account again, through the launch ladder.
 *
 * @module services/heartbeats/accounts/beat-seat
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { projectOfFolder } from '../../core/usage/account-eligibility.js';
import { coreRanking, type RankedAccount } from '../../core/usage/account-ranking.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { usageLimitNow, storedUsageLimit } from '../../rooms/notices/usage-limit.js';
import { nearlyOut, pickReseatAccount } from '../../rooms/reseat/reseat-accounts.js';
import { accountUsageForSession } from '../../session/fleet/session-account.js';

/** Where a beat turn runs. */
export type BeatSeat =
  { kind: 'stay' } | { kind: 'move'; accountId: string } | { kind: 'wait'; until: string | null };

/** The agent a seat is decided for. */
export interface BeatSeatAgent {
  runtime: string;
  projectPath: string;
}

/** How the runner asks where a beat turn runs. */
export interface BeatSeatPort {
  /**
   * Where a beat turn in this chat runs. Never throws: anything it cannot read
   * answers `stay`, so a beat runs as it did before this existed.
   *
   * @param agent - The agent.
   * @param sessionId - The beat chat it would run in.
   * @param opts.afterLimit - The chat's last turn just ran into a usage limit,
   *   so its account counts as out whatever the usage cache says.
   */
  seatFor(
    agent: BeatSeatAgent,
    sessionId: string,
    opts: { afterLimit: boolean }
  ): Promise<BeatSeat>;
  /** Whether this chat's last turn ran into a usage limit that has not reset yet. */
  hitLimit(sessionId: string): boolean;
}

/**
 * The decision, given what was read. Pure.
 *
 * @param input.runtime - The agent's runtime; a move never crosses runtimes.
 * @param input.usage - The usage of the account the chat bills, or `null` when unknown.
 * @param input.afterLimit - The chat's last turn ran into a limit.
 * @param input.ranking - Core's ranking for the folder's project, best first.
 */
export function decideBeatSeat(input: {
  runtime: string;
  usage: AccountUsage | null;
  afterLimit: boolean;
  ranking: readonly RankedAccount[];
}): BeatSeat {
  const out = input.afterLimit || (input.usage !== null && nearlyOut(input.usage));
  if (!out) return { kind: 'stay' };
  const pick = pickReseatAccount(input.ranking, {
    runtime: input.runtime,
    currentAccountId: input.usage?.accountId ?? null,
  });
  if (pick.kind === 'move') return { kind: 'move', accountId: pick.account.id };
  return { kind: 'wait', until: pick.earliestResetAt };
}

/**
 * The production port, over the running server's usage store and ranking.
 *
 * @param folderOf - The folder a turn of the agent stands in. Handed in by the
 *   heartbeats wiring, one of the few places allowed to resolve it (the
 *   one-resolution-per-turn guard in `resolve-session-cwd.subagent.test.ts`).
 */
export function createBeatSeatPort(folderOf: (agentPath: string) => Promise<string>): BeatSeatPort {
  return {
    async seatFor(agent, sessionId, opts) {
      try {
        if (!runtimeRegistry.has(agent.runtime)) return { kind: 'stay' };
        const cwd = await folderOf(agent.projectPath);
        const usage = await accountUsageForSession(
          getAccountUsageStore(),
          runtimeRegistry.get(agent.runtime),
          sessionId,
          cwd
        );
        // A runtime with no usage ledger, and no limit seen: nothing to judge by.
        if (usage === null && !opts.afterLimit) return { kind: 'stay' };
        return decideBeatSeat({
          runtime: agent.runtime,
          usage,
          afterLimit: opts.afterLimit,
          ranking: coreRanking(agent.runtime, await projectOfFolder(cwd)),
        });
      } catch (err) {
        logger.warn('[heartbeats] could not check the beat account; running it where it is', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { kind: 'stay' };
      }
    },
    hitLimit(sessionId) {
      return usageLimitNow(storedUsageLimit, sessionId) !== null;
    },
  };
}
