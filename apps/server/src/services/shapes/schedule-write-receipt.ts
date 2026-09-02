/**
 * The write receipt for Shape-created schedules: a record of the schedule
 * directories a Shape's apply actually wrote, and the authority every ownership
 * question about those directories is answered from (DOR-1524).
 *
 * ## Why a receipt, when the file already says who made it
 *
 * A Shape's schedule carries a provenance marker in its own frontmatter
 * (`origin: shape` + `shape: <name>`), and until now that marker decided two
 * destructive things: whether a re-apply may overwrite a directory, and whether
 * a teardown may delete one. A marker inside a file cannot answer either
 * question honestly, because a marker travels with the bytes:
 *
 * - Copy a Shape's schedule to use as a starting point for your own, keep the
 *   frontmatter, adapt the prompt — and the Shape's next teardown deletes your
 *   directory, because your file says it belongs to that Shape. It does not; it
 *   is a copy of a file that did.
 * - An EMPTY directory at the target name has no file, so it has no marker, so
 *   it read as somebody else's forever: the apply refused it on every run and
 *   said so only in a log line nobody was reading.
 *
 * What a marker genuinely cannot express is the fact the destructive operations
 * need: *this apply wrote this path*. So that is what gets written down here.
 * The receipt is an index of resolved directory paths, one entry per directory a
 * Shape's apply created, and ownership means "the receipt has this path under
 * this Shape's name" — never "the file at this path claims to be ours".
 *
 * ## Where it lives, and what a lost receipt costs
 *
 * One JSON file at `<dorkHome>/shape-schedule-receipts.json`, beside the other
 * install-wide state files (`config.json`, `marketplaces.json`). Install-wide
 * because the directories it names are not: a Shape's schedule starts in
 * `<dorkHome>/skills/` and moves into an agent's `.agents/skills/` when the
 * agent appears.
 *
 * **It is primary state, not a cache.** Nothing on disk can reconstruct it —
 * that is the entire point, since the files themselves only carry a marker
 * anybody could have copied. Deleting it is destructive and unsupported. What it
 * costs is bounded and it fails CLOSED: with the receipt gone nothing is owned,
 * so no re-apply overwrites anything and no teardown deletes anything. A
 * person's files are never at risk from a lost receipt; what is lost is DorkOS's
 * ability to clean up after itself, so a Shape's own schedules outlive the Shape
 * and have to be deleted by hand.
 *
 * Writes are temp-file-plus-rename, the same shape as every other file this repo
 * replaces in place, so a crash mid-write leaves the previous receipt intact
 * rather than a truncated one, and a `.tmp` orphaned by a hard kill is swept on
 * the next load.
 *
 * ## Installs that predate the receipt
 *
 * See {@link ShapeScheduleReceipts.adoptOnce}. The fact that adoption has
 * already happened is recorded in its OWN file
 * (`<dorkHome>/.shape-schedule-ownership-migrated`) rather than inferred from
 * the receipt's existence, so deleting the receipt cannot re-arm a migration
 * that reads ownership out of frontmatter markers again.
 *
 * @module services/shapes/schedule-write-receipt
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '@dorkos/shared/logger';

/** The receipt's filename inside the DorkOS data directory. */
export const SCHEDULE_RECEIPT_FILENAME = 'shape-schedule-receipts.json';

/**
 * The filename recording that the one-time adoption of pre-receipt installs has
 * already run.
 *
 * Deliberately a SEPARATE file from the receipt, and deliberately not sharing
 * its stem: the receipt is the thing somebody might delete believing it to be a
 * cache, and if that also re-armed adoption then every frontmatter marker on the
 * machine — including a person's adapted copy of a Shape's schedule — would be
 * granted ownership all over again. A leading dot keeps it out of a
 * `rm shape-schedule*` glob as well.
 */
export const SCHEDULE_ADOPTION_FILENAME = '.shape-schedule-ownership-migrated';

/** Prefix of the temp file a receipt write renames into place. */
const TEMP_PREFIX = '.shape-schedule-receipts-';

/** Suffix of that temp file. */
const TEMP_SUFFIX = '.tmp';

/** How old an orphaned temp file must be before a load sweeps it (1 hour). */
const TEMP_SWEEP_AGE_MS = 60 * 60 * 1000;

/** One directory a Shape's apply wrote, and the Shape that wrote it. */
export interface ScheduleWriteReceiptEntry {
  /**
   * The resolved absolute path of the schedule's directory (the one holding its
   * `SKILL.md`). Resolved rather than literal because the same directory is
   * reached through different spellings — a `dorkHome` under a symlinked parent
   * is ordinary rather than exotic, and every macOS temp directory is one.
   */
  dir: string;
  /** The Shape that wrote it. */
  shape: string;
  /** ISO 8601 timestamp of the write, for anybody reading the file by hand. */
  writtenAt: string;
}

/** The on-disk receipt. `version` exists so a future format change can migrate. */
const ReceiptFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      dir: z.string(),
      shape: z.string(),
      writtenAt: z.string(),
    })
  ),
});

/** Resolve a path through symlinks, falling back to the path itself. */
async function realPathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/** `JSON.parse` that answers `null` on malformed text instead of throwing. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Whether a path exists at all. */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The receipt of every schedule directory a Shape's apply wrote, and the answer
 * to "is this directory this Shape's to overwrite or delete?".
 *
 * One instance per data directory — see {@link shapeScheduleReceipts}, which is
 * how everything in the server should get one. The instance caches the file in
 * memory and serializes its own writes, so concurrent applies cannot interleave
 * two read-modify-write cycles and lose an entry; two instances over one file
 * would defeat both halves of that.
 */
export class ShapeScheduleReceipts {
  private readonly filePath: string;
  private readonly adoptedPath: string;
  private readonly dir: string;
  private readonly logger: Logger;
  /** The in-memory index, keyed by resolved directory. `null` until loaded. */
  private entries: Map<string, ScheduleWriteReceiptEntry> | null = null;
  /** Whether a receipt file was already on disk when this instance first read. */
  private receiptExisted = false;
  /**
   * Whether the receipt on disk could not be parsed. The next write moves those
   * bytes aside instead of silently replacing them, because they are the only
   * copy of ownership facts nothing else can reconstruct.
   */
  private unreadable = false;
  /** Memoized load, so concurrent callers read the file once. */
  private loaded: Promise<void> | null = null;
  /** Memoized legacy adoption — see {@link ShapeScheduleReceipts.adoptOnce}. */
  private adoption: Promise<void> | null = null;
  /** Write chain: every persist waits for the previous one to settle. */
  private writes: Promise<void> = Promise.resolve();

  /**
   * Build a receipt reader/writer over one DorkOS data directory. Prefer
   * {@link shapeScheduleReceipts} — a second instance over the same file has its
   * own cache and its own write chain, and the two will disagree.
   *
   * @param deps - The data directory the receipt lives in, and a logger.
   */
  constructor(deps: { dorkHome: string; logger: Logger }) {
    this.dir = deps.dorkHome;
    this.filePath = path.join(deps.dorkHome, SCHEDULE_RECEIPT_FILENAME);
    this.adoptedPath = path.join(deps.dorkHome, SCHEDULE_ADOPTION_FILENAME);
    this.logger = deps.logger;
  }

  /**
   * Adopt the schedules of an install that predates the receipt — once per
   * install, ever.
   *
   * At the upgrade boundary the frontmatter marker is the only evidence there
   * is about who wrote what, and it is exactly the evidence the old code acted
   * on. Backfilling from it therefore changes nothing for an existing install:
   * the schedules a Shape owned yesterday are the schedules it owns today, so an
   * uninstall still tears its own timers down instead of leaving them firing
   * forever. What the backfill DOES do is close the trust set. Afterwards the
   * marker never grants ownership again — so a file copied after the upgrade is
   * safe from every Shape, no matter what its frontmatter claims, and only a
   * copy that was already made before the upgrade (and was already in danger
   * from the old code) is exposed to that single pass.
   *
   * **"Once" is recorded in {@link SCHEDULE_ADOPTION_FILENAME}, not in the
   * receipt.** Keying it on the receipt's existence made `rm` of a file that
   * reads like a cache re-run a migration that hands ownership to whatever
   * frontmatter happens to be lying around — the user's adapted copy included.
   * A receipt that exists without that marker file (an install that upgraded
   * mid-development of this change) counts as adopted too, and gets the marker
   * written: adoption never re-runs on an install that already has ownership
   * facts to lose.
   *
   * @param discover - Finds the directories the marker says belong to a Shape.
   *   Called only when adoption actually runs, so a normal install never pays
   *   for the scan.
   */
  async adoptOnce(
    discover: () => Promise<ReadonlyArray<Pick<ScheduleWriteReceiptEntry, 'dir' | 'shape'>>>
  ): Promise<void> {
    this.adoption ??= this.runAdoption(discover);
    return this.adoption;
  }

  /**
   * The Shape that wrote `dir`, or `null` when no Shape did.
   *
   * Answered from the receipt alone. `null` covers every "not ours" case there
   * is — never written by a Shape, written before its entry was lost, already
   * torn down — and every caller treats all of them the same way: leave it be.
   *
   * @param dir - The schedule directory to ask about, resolved or not.
   * @returns The owning Shape's name, or `null`.
   */
  async ownerOf(dir: string): Promise<string | null> {
    const entries = await this.index();
    // The literal spelling first: it is the common case and costs no syscall.
    const direct = entries.get(dir);
    if (direct) return direct.shape;
    return entries.get(await realPathOrSelf(dir))?.shape ?? null;
  }

  /**
   * Record that `shape` wrote `dir`. Overwrites any earlier entry for the same
   * directory, so a re-apply refreshes the timestamp rather than duplicating.
   *
   * A write failure is logged, not thrown: the schedule file is already on disk
   * by the time this runs, and failing the create afterwards would leave a
   * schedule nobody owns AND no schedule. The residual is fail-closed — an
   * unrecorded directory is simply not the Shape's.
   *
   * @param dir - The schedule directory that was written.
   * @param shape - The Shape that wrote it.
   */
  async record(dir: string, shape: string): Promise<void> {
    const entries = await this.index();
    const key = await realPathOrSelf(dir);
    entries.set(key, { dir: key, shape, writtenAt: new Date().toISOString() });
    await this.persist({ propagate: false });
  }

  /**
   * Drop `dir` from the receipt — it is no longer a Shape's.
   *
   * Called when a schedule is torn down, and load-bearing rather than tidy: a
   * stale entry would still name the directory as the Shape's, so a skill a
   * person later creates at that same path would be overwritten by the next
   * re-apply on the strength of a write that was undone.
   *
   * Unlike {@link ShapeScheduleReceipts.record} this THROWS when the receipt
   * cannot be written, because its residual points the other way: a forget that
   * silently failed leaves a claim on a directory that is about to be handed
   * back to the user, which is the one direction this whole mechanism exists to
   * close. The caller decides what to do about it, and must say so out loud.
   *
   * @param dir - The schedule directory that no longer exists.
   * @throws When the receipt could not be rewritten.
   */
  async forget(dir: string): Promise<void> {
    const entries = await this.index();
    const removed = entries.delete(dir) || entries.delete(await realPathOrSelf(dir));
    if (!removed) return;
    await this.persist({ propagate: true });
  }

  /** Load once, then hand back the in-memory index. */
  private async index(): Promise<Map<string, ScheduleWriteReceiptEntry>> {
    this.loaded ??= this.load();
    await this.loaded;
    // `load` always assigns; the non-null read keeps the type honest.
    return this.entries ?? new Map();
  }

  /** Read the receipt from disk (absent or unreadable → an empty index). */
  private async load(): Promise<void> {
    this.entries = new Map();
    void this.sweepStaleTemps();
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      // No receipt yet — an install that predates it, or a fresh one.
      return;
    }
    this.receiptExisted = true;
    const parsed = ReceiptFileSchema.safeParse(parseJson(raw));
    if (!parsed.success) {
      this.unreadable = true;
      this.logger.error(
        `[shape-schedule] Could not read the schedule receipt at ${this.filePath}. No Shape ` +
          `schedule directory counts as DorkOS's until it is rewritten, so nothing will be ` +
          `overwritten or cleaned up; the unreadable file is kept beside it at the next write.`
      );
      return;
    }
    for (const entry of parsed.data.entries) this.entries.set(entry.dir, entry);
  }

  /** The adoption body — see {@link ShapeScheduleReceipts.adoptOnce}. */
  private async runAdoption(
    discover: () => Promise<ReadonlyArray<Pick<ScheduleWriteReceiptEntry, 'dir' | 'shape'>>>
  ): Promise<void> {
    const entries = await this.index();
    // A receipt already on disk means this install has ownership facts of its
    // own, whether or not the marker file was written by an earlier build.
    if ((await exists(this.adoptedPath)) || this.receiptExisted) {
      await this.markAdopted();
      return;
    }
    const writtenAt = new Date().toISOString();
    for (const { dir, shape } of await discover()) {
      const key = await realPathOrSelf(dir);
      entries.set(key, { dir: key, shape, writtenAt });
    }
    await this.persist({ propagate: false });
    await this.markAdopted();
  }

  /**
   * Write the "adoption has run" marker. Best-effort: a machine that cannot
   * write it will re-run adoption next boot, which is the behavior this change
   * replaced rather than a new failure, and shouting about it on every operation
   * would not help.
   */
  private async markAdopted(): Promise<void> {
    if (await exists(this.adoptedPath)) return;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(
        this.adoptedPath,
        `${JSON.stringify({ adoptedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf-8'
      );
    } catch (err) {
      this.logger.warn(
        `[shape-schedule] Could not record that Shape schedule ownership was migrated ` +
          `(${this.adoptedPath})`,
        err
      );
    }
  }

  /**
   * Replace the receipt on disk, temp file then rename, one write at a time.
   *
   * @param opts - `propagate` rethrows a write failure to the caller instead of
   *   only logging it. See {@link ShapeScheduleReceipts.forget}.
   */
  private async persist(opts: { propagate: boolean }): Promise<void> {
    const snapshot: z.infer<typeof ReceiptFileSchema> = {
      version: 1,
      entries: [...(this.entries ?? new Map()).values()],
    };
    let failure: unknown = null;
    // Held separately from the chain so this call awaits ITS write and not
    // whatever else joined the queue behind it.
    const done = this.writes.then(async () => {
      const temp = path.join(this.dir, `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`);
      try {
        await fs.mkdir(this.dir, { recursive: true });
        await this.preserveUnreadable();
        await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
        await fs.rename(temp, this.filePath);
      } catch (err) {
        failure = err;
        await fs.rm(temp, { force: true }).catch(() => {});
        this.logger.error(
          `[shape-schedule] Could not write the schedule receipt at ${this.filePath}`,
          err
        );
      }
    });
    // The body swallows everything, so the chain can never reject and stall
    // every write behind it.
    this.writes = done;
    await done;
    if (failure && opts.propagate) throw failure;
  }

  /**
   * Move an unparseable receipt aside before replacing it. The bytes are the
   * only record of which directories belonged to which Shape, so overwriting
   * them with a single fresh entry would quietly discard every other one; kept
   * beside the receipt, they can be repaired by hand.
   */
  private async preserveUnreadable(): Promise<void> {
    if (!this.unreadable) return;
    // Cleared first: a rename that fails must not make every later write retry
    // it, and the write below is going ahead either way.
    this.unreadable = false;
    const kept = `${this.filePath}.unreadable-${Date.now()}`;
    try {
      await fs.rename(this.filePath, kept);
      this.logger.warn(`[shape-schedule] Kept the unreadable schedule receipt at ${kept}`);
    } catch {
      // Already gone, or not ours to move — the fresh write still stands.
    }
  }

  /**
   * Remove `.tmp` drafts a hard kill left between the write and the rename.
   * Age-gated because a draft seconds old may belong to a write happening right
   * now, in this process or another.
   */
  private async sweepStaleTemps(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - TEMP_SWEEP_AGE_MS;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
      const target = path.join(this.dir, name);
      try {
        if ((await fs.stat(target)).mtimeMs > cutoff) continue;
        await fs.rm(target, { force: true });
      } catch {
        // Raced with somebody else's cleanup. The next load asks again.
      }
    }
  }
}

/** One receipt per data directory, for the lifetime of the process. */
const receiptsByHome = new Map<string, ShapeScheduleReceipts>();

/**
 * The receipt for a DorkOS data directory — the same instance every time.
 *
 * Shared rather than constructed per caller because the instance holds the only
 * in-memory copy of the index and the only write chain over the file. Two
 * instances would diverge the moment one of them wrote: a schedule directory
 * dropped through the tasks routes would still look owned to the Shape service
 * that had already cached it, which is precisely the stale-claim bug the
 * receipt exists to prevent.
 *
 * Keyed on the normalized path rather than the resolved one, because resolving
 * is asynchronous and every caller in the server passes the one `dorkHome`
 * `lib/dork-home.ts` hands out.
 *
 * @param dorkHome - The data directory the receipt lives in.
 * @param logger - Logger for write failures.
 * @returns The process-wide receipt for that directory.
 */
export function shapeScheduleReceipts(dorkHome: string, logger: Logger): ShapeScheduleReceipts {
  const key = path.resolve(dorkHome);
  const existing = receiptsByHome.get(key);
  if (existing) return existing;
  const created = new ShapeScheduleReceipts({ dorkHome: key, logger });
  receiptsByHome.set(key, created);
  return created;
}

/**
 * Drop every cached receipt, so the next {@link shapeScheduleReceipts} reads the
 * file again.
 *
 * @internal Exported for tests, which need to model a restart — the point of the
 * cache is that a live process does not re-read, so without this a test cannot
 * tell "the file says so" from "this instance remembered".
 */
export function resetShapeScheduleReceipts(): void {
  receiptsByHome.clear();
}
