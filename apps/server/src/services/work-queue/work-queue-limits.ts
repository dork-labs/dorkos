/**
 * The limits a work queue stops at (DOR-3462): a full disk, a busy machine, and
 * accounts near their limit. The chat cap is the launch service's own.
 *
 * @module services/work-queue/work-queue-limits
 */
import { statfs } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { CREDITS_ACCOUNT_ID, type AccountUsage } from '@dorkos/shared/account-usage';
import type { WorkQueueHold } from '@dorkos/shared/work-queue-schemas';
import type { RankedAccount } from '../core/usage/account-ranking.js';
import { reseatCandidates } from '../rooms/reseat/reseat-accounts.js';

/** The queue starts nothing with less free disk than this. */
export const MIN_FREE_DISK_BYTES = 20 * 1024 ** 3;

/** The queue starts nothing with a one-minute load average at or above this. */
export const MAX_LOAD_AVERAGE = 16;

/** The queue starts nothing on an account at or above this share of a window. */
export const ACCOUNT_FULL_PCT = 80;

/**
 * Whether the machine has room for another chat, or which limit it is at.
 *
 * @param dorkHome - The data directory, whose disk is the one measured.
 * @returns The limit it is at, or null.
 */
export async function machineHold(dorkHome: string): Promise<WorkQueueHold | null> {
  const disk = await statfs(dorkHome);
  if (disk.bavail * disk.bsize < MIN_FREE_DISK_BYTES) return 'disk';
  const [oneMinute = 0] = loadavg();
  return oneMinute >= MAX_LOAD_AVERAGE ? 'load' : null;
}

/**
 * Whether an account is at {@link ACCOUNT_FULL_PCT} of any known window, or out.
 * Unknown usage is not full: an account nobody has measured is still worth
 * trying, as with a room seat's move.
 *
 * @param usage - The account's usage.
 */
export function accountFull(usage: AccountUsage): boolean {
  if (usage.state === 'limited') return true;
  return usage.windows.some(
    (window) => !window.expired && window.usedPct !== null && window.usedPct >= ACCOUNT_FULL_PCT
  );
}

/**
 * The account with the most room, from core's ranking: the same accounts a room
 * seat may move to (never DorkOS credits, never one a person kept out of
 * automatic moves, never one with a sign-in that needs a look), and none at its
 * limit.
 *
 * @param ranking - Core's ranking for the folder's project, best first.
 * @param runtime - The chat's runtime.
 * @returns The account, or null when none has room.
 */
export function pickQueueAccount(
  ranking: readonly RankedAccount[],
  runtime: string
): RankedAccount | null {
  return (
    reseatCandidates(ranking, runtime).find(
      (row) => row.id !== CREDITS_ACCOUNT_ID && row.eligible && !accountFull(row.usage)
    ) ?? null
  );
}
