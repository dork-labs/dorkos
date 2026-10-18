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
 * neither forgets the limit nor resets the month. The file is read when the counter is made, so
 * the gate always answers from memory. A file that cannot be read (damaged, or written by a newer
 * DorkOS in a shape this one does not know) is moved aside as `teammate-spend.json.corrupt-<time>`
 * and the counter starts empty: no space then has a limit, so none is blocked, and the owner is
 * told once that their limits need setting again. A space with no limit is never blocked by this
 * counter, whatever state the file is in.
 *
 * A running turn is counted when it ends, so the turn that crosses the limit can take a space a
 * little past it; the limit stops the turns after it.
 *
 * @module services/communities/remote/wake/teammate-spend
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import {
  TEAMMATE_SPEND_LIMIT_MIN_USD,
  type CommunityTeammateSpend,
} from '@dorkos/shared/community-teammates';
import { logger } from '../../../../lib/logger.js';
import type { RemoteConnectionStore } from '../connection-store.js';

/**
 * What one teammate turn that reported no cost counts as, in US dollars. An estimate of a typical
 * room turn, deliberately on the high side so a run of unreported turns errs toward the limit.
 */
export const TEAMMATE_TURN_ESTIMATE_USD = 0.25;

/** The file, beside `connections.json` and the wake setting. */
export const TEAMMATE_SPEND_FILE = 'teammate-spend.json';

// Not strict: a newer DorkOS may add a field, and an unknown field must not cost the owner the
// limits they set.
const MonthSchema = z.object({
  /** `YYYY-MM`, UTC. A different month reads as nothing spent. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  usd: z.number().nonnegative(),
  /** How many of the month's turns were counted at the estimate. */
  estimated: z.number().int().nonnegative(),
  /** Whether the owner was told the limit was reached this month. */
  told: z.boolean(),
});
type Month = z.infer<typeof MonthSchema>;

const FileSchema = z.object({
  limits: z.record(z.string(), z.number().min(TEAMMATE_SPEND_LIMIT_MIN_USD)),
  months: z.record(z.string(), MonthSchema),
  /** Each connection's shared folder (DOR-2956), absent in a file from before it. */
  sharedFolders: z.record(z.string(), z.string().min(1)).optional(),
});
type SpendFile = z.infer<typeof FileSchema>;

/**
 * Told once a month, per connection and limit, when teammates' turns reach it. Resolves once the
 * owner was told; a rejection leaves it untold, to be tried again by the next turn counted.
 */
export type TeammateLimitReached = (reached: {
  ref: CommunityRef;
  ownerKey: string;
  limitUsd: number;
  month: string;
}) => Promise<void>;

/** What the owner is told about this counter. */
export interface TeammateSpendNotices {
  /** Teammates' turns reached a space's limit this month. */
  reached?: TeammateLimitReached;
  /** The file could not be read and was set aside, so every limit is gone until set again. */
  reset?: () => void;
}

/** What a turn counts as: its reported cost when that is a real amount, otherwise the estimate. */
function countedCost(costUsd: number | undefined): { usd: number; estimated: boolean } {
  return typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
    ? { usd: costUsd, estimated: false }
    : { usd: TEAMMATE_TURN_ESTIMATE_USD, estimated: true };
}

/** The current month, `YYYY-MM` in UTC. */
function monthOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function key(ref: CommunityRef, ownerKey: string): string {
  return `${ownerKey}\0${ref}`;
}

/** A shared folder the owner named that cannot be shared, with the reason in their words. */
export class SharedFolderRefusedError extends Error {
  /**
   * Name the refusal.
   *
   * @param message - Why, said plainly.
   */
  constructor(message: string) {
    super(message);
    this.name = 'SharedFolderRefusedError';
  }
}

/**
 * Each connection's monthly teammate limit and spending, and the folder it shares with teammates'
 * turns, persisted and read in memory.
 */
export class TeammateSpend {
  private readonly directory: string;
  private readonly file: string;
  private data: SpendFile;
  private writing: Promise<void> = Promise.resolve();

  /**
   * Keep the counter beside the connections, and forget a connection's entry when it goes.
   *
   * @param dorkHome - The DorkOS data directory.
   * @param connections - The connection store, to refuse an unknown connection and forget a
   *   removed one.
   * @param notices - Who tells the owner a limit was reached, or that the file was reset.
   * @param now - The clock.
   */
  constructor(
    dorkHome: string,
    private readonly connections: RemoteConnectionStore,
    private readonly notices: TeammateSpendNotices = {},
    private readonly now: () => number = Date.now
  ) {
    this.directory = path.join(dorkHome, 'communities', 'remote');
    this.file = path.join(this.directory, TEAMMATE_SPEND_FILE);
    // Read now, so the gate never answers before the file is read.
    this.data = this.readOrReset();
    connections.onChange((changes) => {
      const removed = changes.filter((change) => change.status === 'removed');
      if (!removed.length) return;
      void this.exclusive(async (data) => {
        for (const change of removed) {
          delete data.limits[key(change.ref, change.ownerKey)];
          delete data.months[key(change.ref, change.ownerKey)];
          delete data.sharedFolders?.[key(change.ref, change.ownerKey)];
        }
        return true;
      }).catch((error: unknown) => {
        logger.warn('[TeammateSpend] Could not forget a removed connection’s limit', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  /** Read the file again into memory, as at startup. */
  async load(): Promise<void> {
    await this.exclusive(async () => false);
  }

  /**
   * Whether a teammate's post in this space may still wake an agent this month. Always, with no
   * limit set; never, once this month's total has reached it.
   *
   * @param ref - The connection.
   * @param ownerKey - The connection's local owner.
   */
  allows(ref: CommunityRef, ownerKey: string): boolean {
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
  async summary(
    ref: CommunityRef,
    ownerKey: string
  ): Promise<Omit<CommunityTeammateSpend, 'hasAgentsHere'>> {
    await this.connections.get(ref, ownerKey);
    await this.writing;
    const data = this.data;
    const spent = this.spentThisMonth(data.months[key(ref, ownerKey)]);
    return {
      monthlyLimitUsd: data.limits[key(ref, ownerKey)] ?? null,
      spentUsd: Math.round(spent.usd * 100) / 100,
      approximate: spent.estimated > 0,
      month: monthOf(this.now()),
      sharedFolder: data.sharedFolders?.[key(ref, ownerKey)] ?? null,
    };
  }

  /**
   * The folder this space shares with teammates' turns, or `null` for none (DOR-2956). Read from
   * memory, so a teammate turn's tools can ask it on every call.
   *
   * @param ref - The connection.
   * @param ownerKey - The connection's local owner.
   */
  sharedFolder(ref: CommunityRef, ownerKey: string): string | null {
    return this.data.sharedFolders?.[key(ref, ownerKey)] ?? null;
  }

  /**
   * Share a folder with teammates' turns in this space, or stop sharing (DOR-2956). Owner-only by
   * construction, like the limit. The folder must exist and be a folder; it is kept by its
   * realpath, and the computer's root is never shared.
   *
   * @param ref - The connection.
   * @param ownerKey - The connection's local owner.
   * @param folder - An absolute path, or `null` to share nothing.
   * @throws {SharedFolderRefusedError} For a path that is not an existing folder, or the root.
   */
  async setSharedFolder(ref: CommunityRef, ownerKey: string, folder: string | null): Promise<void> {
    await this.connections.get(ref, ownerKey);
    let real: string | null = null;
    if (folder !== null) {
      if (!path.isAbsolute(folder))
        throw new SharedFolderRefusedError('Use the folder’s full path.');
      try {
        real = realpathSync(folder);
      } catch {
        throw new SharedFolderRefusedError('That folder doesn’t exist.');
      }
      if (!statSync(real).isDirectory())
        throw new SharedFolderRefusedError('That’s a file, not a folder.');
      if (path.dirname(real) === real)
        throw new SharedFolderRefusedError('Choose a folder, not the whole disk.');
    }
    await this.exclusive(async (data) => {
      const folders = { ...(data.sharedFolders ?? {}) };
      if (real === null) delete folders[key(ref, ownerKey)];
      else folders[key(ref, ownerKey)] = real;
      data.sharedFolders = folders;
      return true;
    });
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
    const counted = countedCost(costUsd);
    await this.exclusive(async (data) => {
      const current = this.spentThisMonth(data.months[key(ref, ownerKey)]);
      const next: Month = {
        ...current,
        usd: current.usd + counted.usd,
        estimated: current.estimated + (counted.estimated ? 1 : 0),
      };
      const limit = data.limits[key(ref, ownerKey)];
      if (limit !== undefined && next.usd >= limit && !next.told)
        reached = { ref, ownerKey, limitUsd: limit, month: next.month };
      data.months[key(ref, ownerKey)] = next;
      return true;
    });
    if (reached) await this.tell(reached);
  }

  /** Tell the owner a limit was reached, and record it as told only once they were. */
  private async tell(reached: Parameters<TeammateLimitReached>[0]): Promise<void> {
    if (!this.notices.reached) return;
    try {
      await this.notices.reached(reached);
    } catch (error) {
      logger.warn('[TeammateSpend] Could not tell the owner a space reached its limit', {
        communityRef: reached.ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await this.exclusive(async (data) => {
      const month = data.months[key(reached.ref, reached.ownerKey)];
      // Only the same month and limit: a new one since is a new decision, told on its own.
      if (
        month?.month !== reached.month ||
        data.limits[key(reached.ref, reached.ownerKey)] !== reached.limitUsd
      )
        return false;
      month.told = true;
      return true;
    });
  }

  /** A connection's month as recorded, or a fresh one when the record is from another month. */
  private spentThisMonth(recorded: Month | undefined): Month {
    const month = monthOf(this.now());
    return recorded?.month === month ? recorded : { month, usd: 0, estimated: 0, told: false };
  }

  /**
   * The file as it stands, or an empty counter when there is none. A file that cannot be read is
   * moved aside, logged and told to the owner once, and the counter starts empty, so a damaged
   * file never leaves every space unable to change its limit.
   */
  private readOrReset(): SpendFile {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { limits: {}, months: {} };
      return this.reset(error);
    }
    try {
      return FileSchema.parse(JSON.parse(text));
    } catch (error) {
      return this.reset(error);
    }
  }

  private reset(error: unknown): SpendFile {
    const aside = `${this.file}.corrupt-${this.now()}`;
    try {
      renameSync(this.file, aside);
    } catch {
      // Unmovable too: the next write replaces it.
    }
    logger.error('[TeammateSpend] Teammates’ monthly limits could not be read; starting empty', {
      setAside: aside,
      error: error instanceof Error ? error.message : String(error),
    });
    this.notices.reset?.();
    return { limits: {}, months: {} };
  }

  /** Read, change and (when `change` says so) write, one at a time, keeping the copy in memory. */
  private exclusive(change: (data: SpendFile) => Promise<boolean>): Promise<void> {
    const run = async () => {
      const data = this.readOrReset();
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
