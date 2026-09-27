/**
 * Moves the references to a Claude account the `'0.87.0'` config migration
 * renamed (a registry row called `default`, now `default-N` with
 * `renamedFrom: 'default'`), then lets the reconcile drop the marker.
 *
 * A reference names an account by id, and three kinds live outside the config
 * file: an agent manifest's `account` (moved through the mesh registry, which
 * writes the file first), a schedule's `account` with its approval, and the
 * schedule's `SKILL.md` (`services/tasks/approvals/account-rename.ts`). Until
 * all three move, the launch ladder and the usage store keep resolving
 * `default` to the renamed row, so nothing bills a different account.
 *
 * The marker is dropped only when every site moved. A site that is not wired
 * (the agent registry failed to start) or a move that throws keeps the marker,
 * and the next reconcile tries again; every move is idempotent.
 *
 * @module services/core/usage/account-reference-move
 */
import { logger } from '../../../lib/logger.js';

/** One rename to carry through: the old id and the one the migration gave the row. */
export interface AccountRename {
  /** The old registry id (`default`). */
  from: string;
  /** The new one (`default-N`). */
  to: string;
}

/** Where the references to an account live. */
export interface AccountReferenceSites {
  /** The agent registry, or `undefined` when it is not running (nothing then moves). */
  agents:
    | {
        /** Every registered agent, with the account its manifest names. */
        list(): readonly { id: string; account?: string | null }[];
        /** Point one agent's manifest at another account (file first). */
        setAccount(agentId: string, account: string): Promise<void>;
      }
    | undefined;
  /** Move every schedule (row, approval, file) from one account id to another. */
  renameScheduleAccount(from: string, to: string): Promise<unknown>;
}

/**
 * Move every reference named in `renames`. Idempotent.
 *
 * @param renames - The renames whose references should move.
 * @param sites - Where references live.
 * @returns True when every reference moved, so the markers may be dropped.
 */
export async function moveAccountReferences(
  renames: readonly AccountRename[],
  sites: AccountReferenceSites
): Promise<boolean> {
  if (renames.length === 0) return true;
  if (!sites.agents) {
    logger.warn(
      '[account-usage] the agent registry is not running, so a renamed account keeps its old name for now'
    );
    return false;
  }
  for (const { from, to } of renames) {
    for (const agent of sites.agents.list()) {
      if (agent.account === from) await sites.agents.setAccount(agent.id, to);
    }
    await sites.renameScheduleAccount(from, to);
    logger.info('[account-usage] moved every reference to a renamed Claude account', { from, to });
  }
  return true;
}
