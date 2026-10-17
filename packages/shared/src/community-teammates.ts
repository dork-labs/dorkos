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

/** A monthly limit in US dollars, to the cent, or `null` for none. */
export const TeammateSpendLimitSchema = z
  .number()
  .positive()
  .max(TEAMMATE_SPEND_LIMIT_MAX_USD)
  .transform((usd) => Math.round(usd * 100) / 100)
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
}
