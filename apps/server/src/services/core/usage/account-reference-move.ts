/**
 * Moves the references to a Claude account the `'0.87.0'` config migration
 * renamed (a registry row called `default`, now `default-N` with
 * `renamedFrom: 'default'`), then lets the reconcile drop the marker.
 *
 * A reference names an account by id, and three kinds live outside the config
 * file: an agent manifest's `account` (moved through the mesh registry, which
 * writes the file first), a schedule's `account` with its approval, and the
 * schedule's `SKILL.md` (`services/tasks/approvals/account-rename.ts`).
 *
 * A stored session limit (`session_limits.account_id`, spec
 * claude-account-fleet D4) is deliberately NOT a reference to move. Its table
 * is newer than the `'0.87.0'` migration, so every row was written after the
 * rename, from the folder the session actually ran in: a row saying `default`
 * means this computer's own sign-in, and moving it to `default-N` would
 * mislabel it whenever the renamed row's folder is a different one.
 *
 * Until all three move, the launch ladder and the usage store keep resolving
 * `default` to the renamed row, so nothing bills a different account.
 *
 * The marker is dropped only when every site moved. A site that is not wired
 * (the agent registry failed to start) or a move that throws keeps the marker,
 * and the next reconcile tries again; every move is idempotent.
 *
 * @module services/core/usage/account-reference-move
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../../lib/logger.js';

/** Messages already logged by this process, so a 60 s scan does not repeat them. */
const loggedOnce = new Set<string>();

function warnOnce(key: string, message: string, meta?: Record<string, unknown>): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  logger.warn(message, meta);
}

/**
 * Whether an agent's manifest can be rewritten where it is: its project folder
 * exists and its `.dork/agent.json` can be read. A folder that is gone (or on
 * a volume that is not mounted) is skipped rather than recreated by the
 * registry's write, and never blocks the rename.
 */
async function manifestReachable(projectPath: string | undefined): Promise<boolean> {
  if (!projectPath) return false;
  try {
    await fs.access(path.join(projectPath, '.dork', 'agent.json'), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

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
        /** Every registered agent, with the account its manifest names and its folder. */
        list(): readonly { id: string; account?: string | null; projectPath?: string }[];
        /** Point one agent's manifest at another account (file first). */
        setAccount(agentId: string, account: string): Promise<void>;
      }
    | undefined;
  /** Move every schedule (row, approval, file) from one account id to another; package-owned ones stay. */
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
    warnOnce(
      'no-registry',
      '[account-usage] the agent registry is not running, so a renamed account keeps its old name for now'
    );
    return false;
  }
  for (const { from, to } of renames) {
    for (const agent of sites.agents.list()) {
      if (agent.account !== from) continue;
      if (!(await manifestReachable(agent.projectPath))) {
        warnOnce(
          `agent-unreachable:${agent.id}`,
          "[account-usage] skipped an agent whose folder is missing or unreadable while moving a renamed account; its manifest still names the old id, and once the rename marker drops `default` means this computer's own sign-in",
          { agentId: agent.id, projectPath: agent.projectPath }
        );
        continue;
      }
      await sites.agents.setAccount(agent.id, to);
    }
    await sites.renameScheduleAccount(from, to);
    logger.info('[account-usage] moved every reference to a renamed Claude account', { from, to });
  }
  return true;
}
