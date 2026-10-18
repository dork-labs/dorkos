/**
 * What the owner of an install decides about teammates in one space they connected (DOR-2956,
 * `specs/everything-is-a-space` C7): who may wake their agents there, and how much a month the
 * turns teammates start may cost them. Read and written by the owner only, through the local
 * server; the space never sees either.
 *
 * @module shared/community-teammates
 */
import { z } from 'zod';
import type { CommunityWakeAgentsFrom } from './community-connections.js';

/** The largest monthly limit a person may set, in US dollars. A sanity bound, not a price. */
export const TEAMMATE_SPEND_LIMIT_MAX_USD = 100_000;

/** The smallest monthly limit a person may set, in US dollars: one cent. */
export const TEAMMATE_SPEND_LIMIT_MIN_USD = 0.01;

/**
 * Round an amount to the cent, as a limit is kept. Checked AFTER rounding, so an amount that
 * rounds to nothing (a tenth of a cent) is refused rather than saved as a limit of zero.
 *
 * @param usd - An amount in US dollars.
 */
export function roundToCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** A monthly limit in US dollars, to the cent and at least one cent, or `null` for none. */
export const TeammateSpendLimitSchema = z
  .number()
  .transform(roundToCents)
  .pipe(z.number().min(TEAMMATE_SPEND_LIMIT_MIN_USD).max(TEAMMATE_SPEND_LIMIT_MAX_USD))
  .nullable();

/** `PUT /api/community-connections/:ref/teammate-spend`: set or clear the monthly limit. */
export const CommunityTeammateSpendLimitRequestSchema = z.strictObject({
  monthlyLimitUsd: TeammateSpendLimitSchema,
});
/** Set or clear the monthly limit. */
export type CommunityTeammateSpendLimitRequest = z.infer<
  typeof CommunityTeammateSpendLimitRequestSchema
>;

/**
 * One space's teammate spending this month: the limit, if any, and what teammates' turns cost so
 * far. `approximate` is true when any of those turns reported no cost and was counted at a fixed
 * estimate instead.
 */
export const CommunityTeammateSpendSchema = z.strictObject({
  /** The monthly limit in US dollars, or `null`: no limit. */
  monthlyLimitUsd: z.number().positive().nullable(),
  /** What teammates' turns cost this calendar month (UTC), in US dollars. */
  spentUsd: z.number().nonnegative(),
  /** Whether part of `spentUsd` is an estimate. */
  approximate: z.boolean(),
  /** The month counted, `YYYY-MM` (UTC). */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  /**
   * Whether the owner has an agent enrolled in this space, so the panel shows these settings even
   * when the space no longer lets them add one.
   */
  hasAgentsHere: z.boolean(),
  /**
   * The folder this space shares with teammates' turns, or `null` for none (DOR-2956). The only
   * files such a turn may read.
   */
  sharedFolder: z.string().nullable(),
});

/** `PUT /api/community-connections/:ref/teammate-shared-folder`: share a folder, or none. */
export const CommunityTeammateSharedFolderRequestSchema = z.strictObject({
  sharedFolder: z.string().trim().min(1).max(4096).nullable(),
});
/** One space's teammate spending this month. */
export type CommunityTeammateSpend = z.infer<typeof CommunityTeammateSpendSchema>;

/** Owner-only reads and writes of what teammates may do in one connected space. */
export interface CommunityTeammatesTransport {
  /** Who in the space may wake this install's agents there. */
  getCommunityWakeAgentsFrom(ref: string): Promise<CommunityWakeAgentsFrom>;
  /** Set who in the space may wake this install's agents there. */
  setCommunityWakeAgentsFrom(
    ref: string,
    wakeAgentsFrom: CommunityWakeAgentsFrom['wakeAgentsFrom']
  ): Promise<CommunityWakeAgentsFrom>;
  /** The monthly limit and this month's teammate spending in the space. */
  getCommunityTeammateSpend(ref: string): Promise<CommunityTeammateSpend>;
  /** Set or clear the monthly limit; resolves with the spending as it now stands. */
  setCommunityTeammateSpendLimit(
    ref: string,
    monthlyLimitUsd: number | null
  ): Promise<CommunityTeammateSpend>;
  /** Share a folder with teammates' turns, or none; resolves with the settings as they stand. */
  setCommunityTeammateSharedFolder(
    ref: string,
    sharedFolder: string | null
  ): Promise<CommunityTeammateSpend>;
}
