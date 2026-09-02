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
 * install-wide state files (`config.json`, `marketplaces.json`). It is derived,
 * rebuildable state about DorkOS's own writes, not user content, and it is
 * install-wide because the directories it names are not: a Shape's schedule
 * starts in `<dorkHome>/skills/` and moves into an agent's `.agents/skills/`
 * when the agent appears.
 *
 * Writes are temp-file-plus-rename, the same shape as every other file this repo
 * replaces in place, so a crash mid-write leaves the previous receipt intact
 * rather than a truncated one. A receipt that cannot be written is logged and
 * swallowed: the schedule file is already on disk by then, and failing the
 * create afterwards would leave a schedule nobody owns AND no schedule. Losing
 * an entry fails CLOSED — the directory stops being ours, so a later re-apply
 * refuses it and a later teardown leaves it alone. Nothing of the user's is
 * destroyed by a lost receipt; at worst a Shape's own schedule outlives the
 * Shape and has to be deleted by hand.
 *
 * ## Installs that predate the receipt
 *
 * See {@link ShapeScheduleReceipts.adoptOnce}.
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

/**
 * The receipt of every schedule directory a Shape's apply wrote, and the answer
 * to "is this directory this Shape's to overwrite or delete?".
 *
 * One instance per {@link import('./shape-schedule-service.js').ShapeScheduleService};
 * it caches the file in memory and serializes its own writes, so concurrent
 * applies cannot interleave two read-modify-write cycles and lose an entry.
 */
export class ShapeScheduleReceipts {
  private readonly filePath: string;
  private readonly logger: Logger;
  /** The in-memory index, keyed by resolved directory. `null` until loaded. */
  private entries: Map<string, ScheduleWriteReceiptEntry> | null = null;
  /** Whether a receipt file was already on disk when this instance first read. */
  private existedOnDisk = false;
  /** Memoized load, so concurrent callers read the file once. */
  private loaded: Promise<void> | null = null;
  /** Memoized legacy adoption — see {@link ShapeScheduleReceipts.adoptOnce}. */
  private adoption: Promise<void> | null = null;
  /** Write chain: every persist waits for the previous one to settle. */
  private writes: Promise<void> = Promise.resolve();

  /**
   * Build a receipt reader/writer over one DorkOS data directory.
   *
   * @param deps - The data directory the receipt lives in, and a logger for the
   *   one failure this class does not propagate (a receipt it could not write).
   */
  constructor(deps: { dorkHome: string; logger: Logger }) {
    this.filePath = path.join(deps.dorkHome, SCHEDULE_RECEIPT_FILENAME);
    this.logger = deps.logger;
  }

  /**
   * Adopt the schedules of an install that predates the receipt — once, and
   * only when there is no receipt file at all.
   *
   * At the upgrade boundary the frontmatter marker is the only evidence there
   * is about who wrote what, and it is exactly the evidence the old code acted
   * on. Backfilling from it therefore changes nothing for an existing install:
   * the schedules a Shape owned yesterday are the schedules it owns today, so an
   * uninstall still tears its own timers down instead of leaving them firing
   * forever. What the backfill DOES do is close the trust set. From the moment
   * the file exists, the marker never grants ownership again — so a file copied
   * after the upgrade is safe from every Shape, no matter what its frontmatter
   * claims, and only a copy that was already made before the upgrade (and was
   * already in danger from the old code) stays exposed.
   *
   * The receipt is written even when nothing was found, because its EXISTENCE is
   * what records that adoption already happened. A fresh install therefore lands
   * a receipt with no entries on its first Shape operation and never consults a
   * marker at all.
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
   * @param dir - The schedule directory that was written.
   * @param shape - The Shape that wrote it.
   */
  async record(dir: string, shape: string): Promise<void> {
    const entries = await this.index();
    const key = await realPathOrSelf(dir);
    entries.set(key, { dir: key, shape, writtenAt: new Date().toISOString() });
    await this.persist();
  }

  /**
   * Drop `dir` from the receipt — it is no longer a Shape's.
   *
   * Called when a schedule is torn down, and load-bearing rather than tidy: a
   * stale entry would still name the directory as the Shape's, so a skill a
   * person later creates at that same path would be overwritten by the next
   * re-apply on the strength of a write that was undone.
   *
   * @param dir - The schedule directory that no longer exists.
   */
  async forget(dir: string): Promise<void> {
    const entries = await this.index();
    const removed = entries.delete(dir) || entries.delete(await realPathOrSelf(dir));
    if (!removed) return;
    await this.persist();
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
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      // No receipt yet — an install that predates it, or a fresh one.
      return;
    }
    // A receipt that is there but unreadable still counts as "there": rerunning
    // the marker-based adoption over it would re-grant ownership the receipt was
    // written to take away.
    this.existedOnDisk = true;
    const parsed = ReceiptFileSchema.safeParse(parseJson(raw));
    if (!parsed.success) {
      this.logger.warn(
        `[shape-schedule] Could not read the schedule receipt at ${this.filePath}; ` +
          `treating every Shape schedule directory as not ours until it is rewritten`
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
    if (this.existedOnDisk) return;
    const writtenAt = new Date().toISOString();
    for (const { dir, shape } of await discover()) {
      const key = await realPathOrSelf(dir);
      entries.set(key, { dir: key, shape, writtenAt });
    }
    await this.persist();
    this.existedOnDisk = true;
  }

  /**
   * Replace the receipt on disk, temp file then rename, one write at a time.
   *
   * Failure is logged rather than thrown: by the time a receipt is written the
   * schedule file it describes already exists, and throwing here would take down
   * a create that otherwise succeeded.
   */
  private async persist(): Promise<void> {
    const snapshot: z.infer<typeof ReceiptFileSchema> = {
      version: 1,
      entries: [...(this.entries ?? new Map()).values()],
    };
    this.writes = this.writes.then(async () => {
      const temp = path.join(path.dirname(this.filePath), `.${randomUUID()}.tmp`);
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
        await fs.rename(temp, this.filePath);
      } catch (err) {
        await fs.rm(temp, { force: true }).catch(() => {});
        this.logger.warn(
          `[shape-schedule] Could not write the schedule receipt at ${this.filePath}`,
          err
        );
      }
    });
    return this.writes;
  }
}
