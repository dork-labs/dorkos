/**
 * Hot reload for dev links (DOR-2696, spec `marketplace-dev-link` §6, ADR
 * draft D5): an edit in a linked folder reaches DorkOS within seconds, through
 * the seams an install already uses. This module adds no reload of its own.
 *
 * ## What it does
 *
 * One chokidar watch per linked folder (two dev links of the same folder share
 * it). Events are collected and acted on once the folder has been quiet for
 * {@link DEV_LINK_QUIET_MS}, classified by where they happened
 * ({@link classifyDevLinkChanges}):
 *
 * - an edit inside an extension the folder already carries rebuilds that
 *   extension (`reloadExtension`), only when it is turned on and approved;
 * - a new or removed extension folder, or a changed `extension.json`,
 *   re-scans the extensions first (`requestRefresh`);
 * - manifests, skills, commands, hooks and tasks ask a project dev link's
 *   harness projection to run again;
 * - for a global dev link, manifests, hooks, servers, programs, skills,
 *   commands and agents (every file `readRunnableDeclarations` reads, and any
 *   path its plugin.json names) refresh the runtime's plugin list, which also
 *   checks again what the package runs on its own. A project package is not
 *   handed to the SDK as a plugin (it reaches sessions through the projection),
 *   so a project dev link never asks live sessions to reload their plugins;
 * - anything else (a README, `src/`, a log, a swap file) does nothing at all.
 *
 * Events that arrive while a burst is being acted on start their own quiet
 * period once it is done; bursts never run back to back. Plugin refreshes and
 * each dev link's projections run one at a time, with at most one more owed.
 *
 * After each burst it broadcasts `marketplace_dev_link_reloaded` and keeps the
 * time for `DevLinkStatus.lastReloadAt`.
 *
 * ## Why a reload never widens trust
 *
 * A dev link's yes covers the extensions, hooks and programs its folder had
 * when a person approved the card, and edits to those (Phase 1). Every path
 * here goes through the same gate an install's change does, and none records
 * an approval:
 *
 * - An extension is rebuilt only while the load policy already lets it run
 *   (`mayRunExtensionCode`, which for a dev-linked copy means an approval given
 *   to this dev link). A new extension folder is only re-scanned: it is
 *   discovered unapproved and asks in the Activity inbox like any other.
 * - A new hook in a project reaches the harness through the projection's
 *   consent seam, which withholds it and raises the hook card. A new hook,
 *   server or program in a global package is held back by global consent on
 *   the plugin refresh, and asked about on its card.
 *
 * ## What it never does
 *
 * - **Write under the folder.** The extension compiler writes to the build
 *   cache under the DorkOS data directory, and projection writes into the
 *   project. A reload therefore cannot set off another reload, which a test
 *   pins.
 * - **Act on a link that is no longer the dev link.** Every burst is checked
 *   against the registry and the slot first. A record that is gone, a folder
 *   that is missing, or a slot somebody pointed elsewhere (`link-replaced`)
 *   closes the watch and does nothing.
 * - **Queue without bound.** A project's projection holds that project's lock
 *   across a hook card, which a person has hours to answer, so each dev link
 *   has at most one projection running and one more owed, however many edits
 *   arrive meanwhile.
 * - **Watch `.git`, `node_modules`, build, cache and virtual environment
 *   folders, or DorkOS's runtime state** inside the folder
 *   ({@link isIgnoredDevLinkPath}). That is what keeps a folder with thousands
 *   of dependencies cheap.
 * - **Act on a dev link being unlinked.** {@link DevLinkWatcher.hold} marks it
 *   at once and waits for a burst already under way, which checks again before
 *   every rebuild, refresh and owed projection.
 *
 * ## The sweep
 *
 * Every {@link DEV_LINK_REARM_MS} the watcher re-reads the registry, opens a
 * watch for any dev link that has none (a folder that came back), closes the
 * ones no longer in force, and compares a cheap listing of each folder's
 * meaningful directories against the last one it acted on. That follows
 * `services/harness/skills-watcher.ts`, whose measurements explain why: a file
 * written right after a watch opens is dropped 13-40% of the time, a missing
 * folder cannot be watched at all, and a watch can die (`EMFILE`). The same
 * comparison runs once just after each watch settles, to cover the first case
 * straight away. A watch replaced after it died, or a folder that came back,
 * is compared against the listing last acted on, so only what really changed
 * meanwhile is acted on.
 *
 * @module services/marketplace/dev-links/dev-link-watcher
 */
import {
  DevLinkReloadActionSchema,
  type DevLinkRecord,
  type DevLinkReloadAction,
  type DevLinkReloadedEvent,
} from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../../lib/logger.js';
import { readPluginJson } from '../lib/declarations/package-declarations.js';
import {
  classifyDevLinkChanges,
  declaredPathsOf,
  isDevLinkDeclarationChange,
  isIgnoredDevLinkPath,
  relativeTo,
  shapeChanges,
  shapeOf,
  updateShape,
  type DevLinkShape,
  type DevLinkChange,
  type DevLinkChangeKind,
} from './dev-link-changes.js';
import {
  messageOf,
  type DevLinkExtensionReload,
  type DevLinkExtensions,
} from './dev-link-extensions.js';
import { DevLinkLane } from './dev-link-lane.js';
import { chokidarDevLinkWatch, type DevLinkWatchFactory } from './dev-link-watch.js';
import { devLinkStateOf, readDevLinks } from './registry.js';

export type { DevLinkWatchFactory, DevLinkWatchListeners } from './dev-link-watch.js';

/**
 * How long a folder must be quiet before a burst of edits is acted on.
 *
 * An editor's save is several events, a `git checkout` is hundreds, and each
 * is one change to a person. The window restarts on every event, up to
 * {@link DEV_LINK_MAX_WAIT_MS}.
 */
const DEV_LINK_QUIET_MS = 300;

/**
 * The longest a burst waits, however steadily events keep arriving, so a tool
 * that writes into the folder without pause cannot hold every reload back.
 */
const DEV_LINK_MAX_WAIT_MS = 3_000;

/**
 * How often the registry is re-read, missing watches opened and each folder
 * compared against what was last acted on. See the module docs.
 */
const DEV_LINK_REARM_MS = 60_000;

/**
 * How long after chokidar reports `ready` before a watch is treated as live
 * and its folder compared once. `skills-watcher.ts` (`SKILLS_SETTLE_MS`) has
 * the measurement.
 */
const DEV_LINK_SETTLE_MS = 100;

/** What {@link DevLinkWatcher} needs. */
export interface DevLinkWatcherDeps {
  /** Resolved DorkOS data directory, where the registry lives. */
  dorkHome: string;
  /** The extension seams. Absent when extensions did not start: edits there do nothing. */
  extensions?: DevLinkExtensions;
  /**
   * Refresh the runtime's global plugin list and check again what global
   * packages run on their own (global consent). Never called for a project
   * dev link. At most one runs at a time; must not reject.
   */
  refreshPlugins: () => Promise<void>;
  /**
   * Run a project's harness projection through its consent seam, which
   * withholds and asks about new hooks. May stay pending while a card is open.
   */
  reproject: (ctx: { packageName: string; projectPath: string }) => Promise<void>;
  /**
   * After a projection ran, tell the project's command palette its commands
   * changed (drop its cached list, broadcast) without reloading any session's
   * plugins. Must not throw.
   */
  refreshProjectCommands: (projectPath: string) => void;
  /** Broadcast one dev link's reload on the global event stream. */
  broadcast: (event: DevLinkReloadedEvent) => void;
  /** Override {@link DEV_LINK_QUIET_MS}. @internal For tests. */
  quietMs?: number;
  /** Override {@link DEV_LINK_MAX_WAIT_MS}. @internal For tests. */
  maxWaitMs?: number;
  /** Override {@link DEV_LINK_REARM_MS}; `0` switches the timer off. @internal For tests. */
  rearmMs?: number;
  /** Override the sweep's entry cap (`shapeOf`). @internal For tests. */
  sweepMaxEntries?: number;
  /** Override {@link DEV_LINK_SETTLE_MS}. @internal For tests. */
  settleMs?: number;
  /** Override the chokidar watch. @internal For tests. */
  watch?: DevLinkWatchFactory;
  /** The clock. @internal For tests. */
  now?: () => Date;
}

/** The record fields that name one dev link. */
type DevLinkKey = Pick<DevLinkRecord, 'name' | 'scope' | 'projectPath'>;

/** One watched folder and the work pending for it. */
interface WatchedFolder {
  /** The folder's real path; also its key. */
  folder: string;
  /** Every dev link in force that runs from it. */
  records: DevLinkRecord[];
  /** The open watch, absent until armed. */
  handle?: ReturnType<DevLinkWatchFactory>;
  /** Set when the watch reported an error; the sweep replaces it. */
  dead: boolean;
  /** Resolves once the watch has settled. */
  ready: Promise<void>;
  /** Changes not yet acted on, by relative path. */
  pending: Map<string, DevLinkChangeKind>;
  /** The quiet-period timer. */
  timer?: NodeJS.Timeout;
  /** When the current burst began, for {@link DEV_LINK_MAX_WAIT_MS}. */
  burstStartedAt?: number;
  /** The burst being acted on now. */
  inFlight?: Promise<void>;
  /**
   * The listing last acted on ({@link shapeOf}); absent when the folder is too
   * big to list, and then the sweep leaves it to the live watch.
   */
  shape?: DevLinkShape;
  /** The folder was too big to list; latched so it is logged once. */
  capped?: boolean;
  /** Declaration paths the folder's plugin.json names, as last read. */
  declared: string[];
}

/** The stable string key of one dev link. */
function keyOf(record: DevLinkKey): string {
  return JSON.stringify([record.name, record.scope, record.projectPath ?? null]);
}

/** Whether a record still names the same dev link and folder. */
function sameRecord(a: DevLinkRecord, b: DevLinkRecord): boolean {
  return keyOf(a) === keyOf(b) && a.target === b.target && a.slot === b.slot;
}

/** The order actions are reported in. */
const ACTION_ORDER = DevLinkReloadActionSchema.options;

/**
 * Watches every dev link in force and drives the existing reload seams. One
 * instance per server; {@link start} at boot, {@link stop} at shutdown.
 */
export class DevLinkWatcher {
  private readonly folders = new Map<string, WatchedFolder>();
  /**
   * Folders whose watch closed because the folder went missing, with the
   * listing last acted on (absent when it was never watched), for a catch-up
   * on return.
   */
  private readonly lost = new Map<string, DevLinkShape | 'unlisted' | undefined>();
  /** Each dev link's projections. */
  private readonly lanes = new Map<string, DevLinkLane>();
  /** Global plugin refreshes, shared by every global dev link. */
  private readonly pluginLane = new DevLinkLane({
    job: () => this.deps.refreshPlugins(),
    mayRun: () => !this.stopped,
    failure: 'Refreshing plugins after a dev link edit failed',
  });
  private readonly lastReloads = new Map<string, string>();
  /** Dev links being unlinked: never watched or acted on until released. */
  private readonly held = new Set<string>();
  /** Every change to the watched set, one at a time. */
  private chain: Promise<void> = Promise.resolve();
  private sweeper?: NodeJS.Timeout;
  private stopped = false;
  private readonly watch: DevLinkWatchFactory;

  /**
   * Build the watcher; nothing is watched until {@link start}.
   *
   * @param deps - See {@link DevLinkWatcherDeps}.
   */
  constructor(private readonly deps: DevLinkWatcherDeps) {
    this.watch = deps.watch ?? chokidarDevLinkWatch;
  }

  /**
   * Watch every dev link in force now, and start the periodic sweep.
   *
   * @returns Once every watch is opened (not yet settled; see {@link ready}).
   */
  async start(): Promise<void> {
    const rearmMs = this.deps.rearmMs ?? DEV_LINK_REARM_MS;
    if (rearmMs > 0 && !this.sweeper) {
      this.sweeper = setInterval(() => void this.sweep(), rearmMs);
      this.sweeper.unref?.();
    }
    await this.sync();
  }

  /**
   * Bring the watched set in line with the registry: open a watch for each dev
   * link in force that has none, and close the ones no longer in force. Never
   * throws.
   */
  sync(): Promise<void> {
    return this.serialize(() => this.runSync());
  }

  /**
   * Stop watching and acting on one dev link, before it is unlinked, until
   * {@link release}. Its folder's watch closes when no other dev link uses it.
   * Resolves only once a burst already being acted on for it has finished,
   * so nothing rebuilds or projects for it after this returns.
   *
   * @param record - Which dev link.
   */
  async hold(record: DevLinkKey): Promise<void> {
    const key = keyOf(record);
    // Marked at once: a burst under way checks it before each step.
    this.held.add(key);
    // Waited on outside `serialize`: a burst whose gate closes its watch goes
    // through `serialize` itself, so waiting inside it would never end.
    await Promise.allSettled(
      [...this.folders.values()]
        .filter((watched) => watched.records.some((r) => keyOf(r) === key))
        .map((watched) => watched.inFlight)
    );
    await this.serialize(async () => {
      for (const watched of [...this.folders.values()]) {
        watched.records = watched.records.filter((r) => keyOf(r) !== key);
        if (watched.records.length === 0) await this.close(watched);
      }
    });
  }

  /**
   * Let a held dev link be watched again if it is still in force (an unlink
   * that failed part way), then sync.
   *
   * @param record - Which dev link.
   */
  async release(record: DevLinkKey): Promise<void> {
    this.held.delete(keyOf(record));
    await this.sync();
  }

  /**
   * When an edit last reloaded a dev link, since the server started.
   *
   * @param record - Which dev link.
   * @returns ISO 8601, or `undefined` before the first reload.
   */
  lastReloadAt(record: DevLinkKey): string | undefined {
    return this.lastReloads.get(keyOf(record));
  }

  /** The folders being watched now, sorted. */
  watchedFolders(): string[] {
    return [...this.folders.values()]
      .filter((watched) => watched.handle && !watched.dead)
      .map((watched) => watched.folder)
      .sort();
  }

  /** Resolves once every open watch has settled. */
  async ready(): Promise<void> {
    await this.chain;
    await Promise.all([...this.folders.values()].map((watched) => watched.ready));
  }

  /**
   * Re-read the registry, re-arm, and compare every folder against what was
   * last acted on. Runs on the timer.
   *
   * @internal Exported for tests, which drive it instead of waiting a minute.
   */
  async sweep(): Promise<void> {
    await this.sync();
    for (const watched of this.folders.values()) {
      if (!watched.handle || watched.dead) continue;
      this.compare(watched, watched.shape, await this.listing(watched));
    }
  }

  /**
   * Act on what differs between two listings, and keep the newer one as the
   * baseline. Either missing (a folder too big to list) compares nothing.
   */
  private compare(
    watched: WatchedFolder,
    before: DevLinkShape | undefined,
    now: DevLinkShape | undefined
  ): void {
    if (before && now) this.enqueue(watched, shapeChanges(before, now));
    watched.shape = now;
  }

  /**
   * The folder's listing now, or `undefined` when it is too big to list. That
   * is logged once per folder: a cut listing would report changes that never
   * happened, so the live watch is all there is for it.
   */
  private async listing(watched: WatchedFolder): Promise<DevLinkShape | undefined> {
    const shape = await shapeOf(watched.folder, watched.declared, this.deps.sweepMaxEntries);
    if (!shape && !watched.capped) {
      logger.warn('[Marketplace] A dev link folder is too big to compare; only its watch is used', {
        folder: watched.folder,
      });
    }
    watched.capped = !shape;
    return shape ?? undefined;
  }

  /** What a lost folder's catch-up compares against. */
  private lastListing(watched: WatchedFolder | undefined): DevLinkShape | 'unlisted' | undefined {
    return watched?.capped ? 'unlisted' : watched?.shape;
  }

  /**
   * Act on everything pending now, including what arrives while doing so, and
   * wait for it.
   *
   * @internal For tests: it collapses the quiet period.
   */
  async flush(): Promise<void> {
    // Bounded, so a test whose folder never stops changing cannot hang here.
    for (let pass = 0; pass < 10; pass++) {
      for (const watched of this.folders.values()) {
        if (watched.timer) {
          clearTimeout(watched.timer);
          watched.timer = undefined;
          this.fire(watched);
        }
      }
      const busy = [...this.folders.values()].filter((watched) => watched.inFlight);
      if (busy.length === 0) return;
      await Promise.all(busy.map((watched) => watched.inFlight));
    }
  }

  /**
   * Wait for every projection and plugin refresh this watcher started.
   *
   * @internal For tests.
   */
  async projectionsIdle(): Promise<void> {
    await Promise.all([...this.lanes.values(), this.pluginLane].map((lane) => lane.inFlight));
  }

  /** Close every watch, drop everything pending, and wait for a burst being acted on. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    await this.chain;
    const inFlight = [...this.folders.values()].map((watched) => watched.inFlight);
    for (const watched of [...this.folders.values()]) await this.close(watched);
    // Projections are not awaited: one can wait hours on a hook card, and it
    // writes nothing once its answer arrives after the server has gone.
    await Promise.allSettled(inFlight);
  }

  /** Run `job` after every earlier change to the watched set. Never rejects. */
  private serialize(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(job).catch((err) => {
      logger.warn('[Marketplace] Dev link watcher could not update its watches', { err });
    });
    this.chain = next;
    return next;
  }

  /** One pass of {@link sync}. */
  private async runSync(): Promise<void> {
    if (this.stopped) return;
    const reading = await readDevLinks(this.deps.dorkHome);
    // An unreadable registry means no slot counts as a dev link: watch nothing.
    const records = 'links' in reading ? reading.links : [];
    const recorded = new Set(records.map(keyOf));
    for (const key of [...this.held]) if (!recorded.has(key)) this.held.delete(key);
    // A folder no dev link runs from any more owes no catch-up.
    const targets = new Set(records.map((record) => record.target));
    for (const folder of [...this.lost.keys()]) if (!targets.has(folder)) this.lost.delete(folder);
    for (const key of [...this.lastReloads.keys()]) {
      if (!recorded.has(key)) this.lastReloads.delete(key);
    }

    const wanted = new Map<string, DevLinkRecord[]>();
    for (const record of records) {
      if (this.held.has(keyOf(record))) continue;
      const state = await devLinkStateOf(record);
      if (state === 'folder-missing' && !this.lost.has(record.target)) {
        this.lost.set(record.target, this.lastListing(this.folders.get(record.target)));
      }
      if (state !== 'active') continue;
      wanted.set(record.target, [...(wanted.get(record.target) ?? []), record]);
    }
    if (this.stopped) return;

    for (const watched of [...this.folders.values()]) {
      if (!wanted.has(watched.folder)) await this.close(watched);
    }
    for (const [folder, folderRecords] of wanted) {
      let watched = this.folders.get(folder);
      if (!watched) {
        watched = {
          folder,
          records: [],
          dead: false,
          ready: Promise.resolve(),
          pending: new Map(),
          declared: [],
        };
        this.folders.set(folder, watched);
      }
      watched.records = folderRecords;
      if (watched.handle && !watched.dead) continue;
      // A folder that went missing and is back, or a watch that died: what
      // changed meanwhile was never seen, so it is compared against the
      // listing last acted on. A folder never watched before has none, and
      // everything in it is new; one too big to list is left to its watch.
      let catchUpFrom: DevLinkShape | undefined;
      if (this.lost.has(folder)) {
        const last = this.lost.get(folder);
        catchUpFrom = last === 'unlisted' ? undefined : (last ?? new Map());
        this.lost.delete(folder);
      } else if (watched.dead) {
        catchUpFrom = watched.shape;
      }
      await this.arm(watched, catchUpFrom);
    }
  }

  /**
   * Open (or replace) the watch on one folder.
   *
   * @param catchUpFrom - The listing last acted on, when changes may have been
   *   missed: whatever differs from it now is acted on.
   */
  private async arm(watched: WatchedFolder, catchUpFrom: DevLinkShape | undefined): Promise<void> {
    if (watched.handle) await watched.handle.close().catch(() => undefined);
    watched.handle = undefined;
    watched.dead = false;
    watched.declared = declaredPathsOf(await readPluginJson(watched.folder));
    // Read before the watch opens, so a write in the moments after is a
    // difference the settle comparison finds.
    const before = await this.listing(watched);
    watched.shape = before;
    const settleMs = this.deps.settleMs ?? DEV_LINK_SETTLE_MS;
    const seenCodes = new Set<string>();
    let settled!: () => void;
    watched.ready = new Promise<void>((resolve) => {
      settled = resolve;
    });
    let readyOnce = false;
    const onSettled = (): void => {
      if (readyOnce) return;
      readyOnce = true;
      const timer = setTimeout(() => {
        void this.compareAfterSettle(watched).finally(settled);
      }, settleMs);
      timer.unref?.();
    };
    watched.handle = this.watch(
      watched.folder,
      (absPath, isDirectory) => {
        const rel = relativeTo(watched.folder, absPath);
        return rel !== null && isIgnoredDevLinkPath(rel, isDirectory, watched.declared);
      },
      {
        onEvent: (kind, absPath) => {
          const rel = relativeTo(watched.folder, absPath);
          if (rel === null) return;
          this.enqueue(watched, [{ rel, kind }]);
        },
        onReady: onSettled,
        onError: (err) => {
          const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
          // Latched per code, as `skills-watcher.ts` does, so one storm is one line.
          if (!seenCodes.has(code)) {
            seenCodes.add(code);
            logger.warn('[Marketplace] A dev link watch failed; the sweep replaces it', {
              folder: watched.folder,
              code,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          watched.dead = true;
          onSettled();
        },
      }
    );
    if (catchUpFrom && before) this.enqueue(watched, shapeChanges(catchUpFrom, before));
  }

  /** The one comparison right after a watch settles. */
  private async compareAfterSettle(watched: WatchedFolder): Promise<void> {
    if (this.stopped || this.folders.get(watched.folder) !== watched || !watched.handle) return;
    this.compare(watched, watched.shape, await this.listing(watched));
  }

  /**
   * Add changes to a folder's burst and (re)start its quiet period. A change
   * no declaration or extension lives at is dropped here, so it never wakes
   * anything. One entry per path: the latest kind, except that a later
   * `change` never hides an `add` or `unlink` before it.
   */
  private enqueue(watched: WatchedFolder, changes: readonly DevLinkChange[]): void {
    if (this.stopped || this.folders.get(watched.folder) !== watched) return;
    let added = false;
    for (const change of changes) {
      if (!isDevLinkDeclarationChange(change, watched.declared)) continue;
      const was = watched.pending.get(change.rel);
      watched.pending.set(
        change.rel,
        was !== undefined && change.kind === 'change' ? was : change.kind
      );
      added = true;
    }
    if (!added) return;
    watched.burstStartedAt ??= Date.now();
    // A burst is being acted on: these wait for it, then for their own quiet
    // period (see `fire`).
    if (watched.inFlight) return;
    this.schedule(watched);
  }

  /** (Re)start a folder's quiet period, capped by the maximum wait. */
  private schedule(watched: WatchedFolder): void {
    const quietMs = this.deps.quietMs ?? DEV_LINK_QUIET_MS;
    const maxWaitMs = this.deps.maxWaitMs ?? DEV_LINK_MAX_WAIT_MS;
    const now = Date.now();
    watched.burstStartedAt ??= now;
    if (watched.timer) clearTimeout(watched.timer);
    const delay = Math.max(0, Math.min(quietMs, watched.burstStartedAt + maxWaitMs - now));
    watched.timer = setTimeout(() => {
      watched.timer = undefined;
      this.fire(watched);
    }, delay);
    watched.timer.unref?.();
  }

  /**
   * Start acting on a folder's burst. What arrives meanwhile is acted on after
   * a fresh quiet period from when this one finishes, never straight away, so
   * a folder that keeps changing cannot drive one reload after another.
   */
  private fire(watched: WatchedFolder): void {
    if (watched.inFlight || watched.pending.size === 0) return;
    const changes = [...watched.pending].map(([rel, kind]) => ({ rel, kind }));
    watched.pending.clear();
    watched.burstStartedAt = undefined;
    const run = (async () => {
      try {
        await this.act(watched, changes);
      } catch (err) {
        logger.warn('[Marketplace] A dev link reload failed', { folder: watched.folder, err });
      } finally {
        watched.inFlight = undefined;
        if (
          watched.pending.size > 0 &&
          !this.stopped &&
          this.folders.get(watched.folder) === watched
        ) {
          watched.burstStartedAt = Date.now();
          this.schedule(watched);
        }
      }
    })();
    watched.inFlight = run;
  }

  /** Act on one burst for one folder. Never throws. */
  private async act(watched: WatchedFolder, changes: readonly DevLinkChange[]): Promise<void> {
    // The gate: only dev links still recorded, not being unlinked, and in
    // force right now. A folder that went missing or a slot pointed elsewhere
    // stops here, and its watch closes.
    const live = await this.liveRecords(watched);
    if (live.length === 0) {
      await this.serialize(async () => {
        if (this.folders.get(watched.folder) === watched && watched.records.length > 0) {
          const states = await Promise.all(watched.records.map((r) => devLinkStateOf(r)));
          if (states.includes('folder-missing')) {
            this.lost.set(watched.folder, this.lastListing(watched));
          }
        }
        await this.close(watched);
      });
      return;
    }
    const declared = declaredPathsOf(await readPluginJson(watched.folder));
    const declaredChanged = declared.join('\n') !== watched.declared.join('\n');
    watched.declared = declared;
    // Only the paths this burst touched are read again, so the sweep does not
    // act on them a second time; the full walk is the sweep's job.
    if (watched.shape) await updateShape(watched.folder, watched.shape, changes, declared);
    if (declaredChanged && watched.handle) {
      // The watch decided what to skip with the old paths: a folder plugin.json
      // now names may never have been opened. Replace it; its catch-up
      // compares against the listing just updated, so nothing runs twice.
      watched.dead = true;
      void this.sync();
    }
    // A dev link held since the gate (an unlink started) is dropped before
    // every step that rebuilds, refreshes or projects anything.
    const inForce = (): DevLinkRecord[] => live.filter((r) => !this.held.has(keyOf(r)));

    const extensions = this.deps.extensions;
    const carried = (): Map<string, string[]> => {
      const byDir = new Map<string, string[]>();
      for (const { id, dir } of extensions?.carriedBy(watched.folder) ?? []) {
        byDir.set(dir, [...(byDir.get(dir) ?? []), id]);
      }
      return byDir;
    };
    let known = carried();
    const plan = classifyDevLinkChanges(changes, new Set(known.keys()), watched.declared);
    const actions = new Set<DevLinkReloadAction>();
    const errors: string[] = [];

    if (extensions && (plan.refreshExtensions || plan.reload.length > 0)) {
      if (plan.refreshExtensions) {
        if (inForce().length === 0) return;
        try {
          await extensions.refresh();
          actions.add('extension');
        } catch (err) {
          errors.push(`Extensions couldn't be scanned again: ${messageOf(err)}`);
        }
        known = carried();
      }
      const ids = new Set(plan.reload.flatMap((dir) => known.get(dir) ?? []));
      for (const id of [...ids].sort()) {
        if (inForce().length === 0) return;
        const result = await extensions
          .reload(id)
          .catch((err): DevLinkExtensionReload => ({ outcome: 'failed', error: messageOf(err) }));
        if (result.outcome === 'skipped') continue;
        actions.add('extension');
        if (result.outcome === 'failed') errors.push(`${id} didn't build: ${result.error}`);
      }
    }

    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    for (const record of inForce()) {
      const recordActions = new Set(actions);
      if (record.projectPath === undefined) {
        // Global packages are not projected by DorkOS (the same as an
        // install, `runAutoProjection`); the plugin refresh is what loads a
        // changed declaration and re-checks global consent for a new one.
        if (plan.plugins) {
          this.pluginLane.request();
          recordActions.add('plugins');
        }
      } else if (plan.projection || plan.plugins) {
        // A project package is not an SDK plugin: its declarations reach
        // sessions through the projection, which is also where a new hook is
        // withheld and asked about. Live sessions' plugins are left alone.
        this.project(record, record.projectPath);
        recordActions.add('projection');
      }
      if (recordActions.size === 0 && errors.length === 0) continue;
      this.lastReloads.set(keyOf(record), at);
      const event: DevLinkReloadedEvent = {
        name: record.name,
        scope: record.scope,
        ...(record.projectPath !== undefined && { projectPath: record.projectPath }),
        at,
        actions: ACTION_ORDER.filter((action) => recordActions.has(action)),
        ...(errors.length > 0 && { errors }),
      };
      try {
        this.deps.broadcast(event);
      } catch (err) {
        logger.warn('[Marketplace] Broadcasting a dev link reload failed', { err });
      }
    }
  }

  /** The folder's dev links that are still recorded, not held, and in force. */
  private async liveRecords(watched: WatchedFolder): Promise<DevLinkRecord[]> {
    if (this.stopped || this.folders.get(watched.folder) !== watched) return [];
    const reading = await readDevLinks(this.deps.dorkHome);
    if ('unreadable' in reading) return [];
    const live: DevLinkRecord[] = [];
    for (const record of watched.records) {
      if (this.held.has(keyOf(record))) continue;
      const current = reading.links.find((link) => sameRecord(link, record));
      if (!current) continue;
      if ((await devLinkStateOf(current)) === 'active') live.push(current);
    }
    return live;
  }

  /** Ask for one projection of a project dev link, coalesced with any in flight. */
  private project(record: DevLinkRecord, projectPath: string): void {
    const key = keyOf(record);
    let lane = this.lanes.get(key);
    if (!lane) {
      const own: DevLinkLane = new DevLinkLane({
        job: async () => {
          await this.deps.reproject({ packageName: record.name, projectPath });
          // A projected command or skill is new to this project's cached
          // command list, which nothing else refreshes for a project package.
          this.deps.refreshProjectCommands(projectPath);
        },
        // An owed projection never runs once its dev link is being unlinked.
        mayRun: () => !this.stopped && !this.held.has(key),
        failure: 'Projecting after a dev link edit failed',
        onIdle: () => {
          if (this.lanes.get(key) === own) this.lanes.delete(key);
        },
      });
      this.lanes.set(key, (lane = own));
    }
    lane.request();
  }

  /** Close one folder's watch and forget it. */
  private async close(watched: WatchedFolder): Promise<void> {
    if (watched.timer) clearTimeout(watched.timer);
    watched.timer = undefined;
    watched.pending.clear();
    if (this.folders.get(watched.folder) === watched) this.folders.delete(watched.folder);
    const handle = watched.handle;
    watched.handle = undefined;
    await handle?.close().catch(() => undefined);
  }
}
