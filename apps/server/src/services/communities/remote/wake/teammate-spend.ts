/**
 * The card limit (DOR-2956, `specs/everything-is-a-space` C7): how much a month the turns that
 * teammates start in one space may cost this install's owner, and what they cost so far.
 *
 * The owner sets a monthly limit per connection, in US dollars, or none (the default, which is
 * today's behaviour). Each teammate's turn adds what its runtime reported it cost; a turn that
 * reported nothing counts at {@link TEAMMATE_TURN_ESTIMATE_USD}, and the month is then marked
 * approximate. Once a month's total reaches the limit, a teammate's post wakes nobody until the
 * next month, and the owner is told once that month.
 *
 * It is a different thing from the wake budget (`answer-in.ts`: three wakes per person and
 * twenty per channel every ten minutes). That one stops a flood; this one caps the owner's money.
 * Both apply, and the owner's own posts count against neither.
 *
 * Kept in `teammate-spend.json` beside the connections and their wake setting, so a restart
 * neither forgets the limit nor resets the month. The gate reads it in memory: until the file is
 * read, a connection with a limit wakes no teammate, rather than one that might be over it.
 *
 * @module services/communities/remote/wake/teammate-spend
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityTeammateSpend } from '@dorkos/shared/community-teammates';
import { logger } from '../../../../lib/logger.js';
import type { RemoteConnectionStore } from '../connection-store.js';

/**
 * What one teammate turn that reported no cost counts as, in US dollars. An estimate of a typical
 * room turn, deliberately on the high side so a run of unreported turns errs toward the limit.
 */
export const TEAMMATE_TURN_ESTIMATE_USD = 0.25;

/** The file, beside `connections.json` and the wake setting. */
export const TEAMMATE_SPEND_FILE = 'teammate-spend.json';

const MonthSchema = z.strictObject({
  /** `YYYY-MM`, UTC. A different month reads as nothing spent. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  usd: z.number().nonnegative(),
  /** How many of the month's turns were counted at the estimate. */
  estimated: z.number().int().nonnegative(),
  /** Whether the owner was told the limit was reached this month. */
  told: z.boolean(),
});
type Month = z.infer<typeof MonthSchema>;

const FileSchema = z.strictObject({
  limits: z.record(z.string(), z.number().positive()),
  months: z.record(z.string(), MonthSchema),
});
type SpendFile = z.infer<typeof FileSchema>;

/** Told once a month, per connection, when teammates' turns reach its limit. */
export type TeammateLimitReached = (reached: {
  ref: CommunityRef;
  ownerKey: string;
  limitUsd: number;
  month: string;
}) => void;

/** The current month, `YYYY-MM` in UTC. */
function monthOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function key(ref: CommunityRef, ownerKey: string): string {
  return `${ownerKey}\0${ref}`;
}

/** Each connection's monthly teammate limit and spending, persisted and read in memory. */
export class TeammateSpend {
  private readonly directory: string;
  private readonly file: string;
  private data: SpendFile | null = null;
  private writing: Promise<void> = Promise.resolve();

  /**
   * Keep the counter beside the connections, and forget a connection's entry when it goes.
   *
   * @param dorkHome - The DorkOS data directory.
   * @param connections - The connection store, to refuse an unknown connection and forget a
   *   removed one.
   * @param reached - Told once a month per connection when the limit is reached.
   * @param now - The clock.
   */
  constructor(
    dorkHome: string,
    private readonly connections: RemoteConnectionStore,
    private readonly reached: TeammateLimitReached = () => undefined,
    private readonly now: () => number = Date.now
  ) {
    this.directory = path.join(dorkHome, 'communities', 'remote');
    this.file = path.join(this.directory, TEAMMATE_SPEND_FILE);
    connections.onChange((changes) => {
      const removed = changes.filter((change) => change.status === 'removed');
      if (!removed.length) return;
      void this.exclusive(async (data) => {
        for (const change of removed) {
          delete data.limits[key(change.ref, change.ownerKey)];
          delete data.months[key(change.ref, change.ownerKey)];
        }
        return true;
      }).catch((error: unknown) => {
        logger.warn('[TeammateSpend] Could not forget a removed connection’s limit', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  /** Read the file into memory. Until it is read, a connection with a limit wakes no teammate. */
  async load(): Promise<void> {
    await this.exclusive(async () => false);
  }

  /**
   * Whether a teammate's post in this space may still wake an agent this month. Always, with no
   * limit set; never, once this month's total has reached it, or before the file is read.
   *
   * @param ref - The connection.
   * @param ownerKey - The connection's local owner.
   */
  allows(ref: CommunityRef, ownerKey: string): boolean {
    if (!this.data) return false;
    const limit = this.data.limits[key(ref, ownerKey)];
    if (limit === undefined) return true;
    return this.spentThisMonth(this.data.months[key(ref, ownerKey)]).usd < limit;
  }

  /**
   * The limit and this month's spending, for the owner's screen.
   *
   * @param ref - The connection.
   * @param ownerKey - The connection's local owner.
   */
  async summary(ref: CommunityRef, ownerKey: string): Promise<CommunityTeammateSpend> {
    await this.connections.get(ref, ownerKey);
    const data = await this.read();
    const spent = this.spentThisMonth(data.months[key(ref, ownerKey)]);
    return {
      monthlyLimitUsd: data.limits[key(ref, ownerKey)] ?? null,
      spentUsd: Math.round(spent.usd * 100) / 100,
      approximate: spent.estimated > 0,
      month: monthOf(this.now()),
    };
  }

  /**
   * Set or clear a connection's monthly limit. Owner-only by construction: the one route that
   * calls it refuses every caller but this install's owner, and no DorkOS tool reaches it.
   *
   * @param ref - The connection.
   * @param ownerKey - The connection's local owner.
   * @param limitUsd - The limit in US dollars, or `null` for none.
   */
  async setLimit(ref: CommunityRef, ownerKey: string, limitUsd: number | null): Promise<void> {
    await this.connections.get(ref, ownerKey);
    await this.exclusive(async (data) => {
      if (limitUsd === null) delete data.limits[key(ref, ownerKey)];
      else data.limits[key(ref, ownerKey)] = limitUsd;
      // A new limit is a new decision: if this month is already past it, say so again.
      const month = data.months[key(ref, ownerKey)];
      if (month) month.told = false;
      return true;
    });
  }

  /**
   * Count one teammate turn's cost against its connection's month, and tell the owner the first
   * time this month that the total reaches the limit.
   *
   * @param ref - The connection the turn's room belongs to.
   * @param ownerKey - The connection's local owner.
   * @param costUsd - What the runtime reported the turn cost, or `undefined` when it reported
   *   nothing, which counts at {@link TEAMMATE_TURN_ESTIMATE_USD}.
   */
  async record(ref: CommunityRef, ownerKey: string, costUsd: number | undefined): Promise<void> {
    let reached: Parameters<TeammateLimitReached>[0] | null = null;
    await this.exclusive(async (data) => {
      const current = this.spentThisMonth(data.months[key(ref, ownerKey)]);
      const next: Month = {
        ...current,
        usd: current.usd + (costUsd ?? TEAMMATE_TURN_ESTIMATE_USD),
        estimated: current.estimated + (costUsd === undefined ? 1 : 0),
      };
      const limit = data.limits[key(ref, ownerKey)];
      if (limit !== undefined && next.usd >= limit && !next.told) {
        next.told = true;
        reached = { ref, ownerKey, limitUsd: limit, month: next.month };
      }
      data.months[key(ref, ownerKey)] = next;
      return true;
    });
    if (reached) this.reached(reached);
  }

  /** A connection's month as recorded, or a fresh one when the record is from another month. */
  private spentThisMonth(recorded: Month | undefined): Month {
    const month = monthOf(this.now());
    return recorded?.month === month ? recorded : { month, usd: 0, estimated: 0, told: false };
  }

  private async read(): Promise<SpendFile> {
    try {
      return FileSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { limits: {}, months: {} };
      throw error;
    }
  }

  /** Read, change and (when `change` says so) write, one at a time, keeping the copy in memory. */
  private exclusive(change: (data: SpendFile) => Promise<boolean>): Promise<void> {
    const run = async () => {
      const data = await this.read();
      if (await change(data)) await this.write(data);
      this.data = data;
    };
    const result = this.writing.then(run, run);
    this.writing = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async write(data: SpendFile): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.teammate-spend-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
