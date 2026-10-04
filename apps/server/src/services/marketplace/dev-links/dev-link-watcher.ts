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
 * - skills, commands, hooks and tasks ask a project dev link's harness
 *   projection to run again;
 * - manifests, hooks, servers, programs and everything else refresh the
 *   runtime's plugin list, which also checks again what the package runs on
 *   its own.
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
 * - **Watch `.git`, `node_modules` or DorkOS's runtime state** inside the
 *   folder ({@link isIgnoredDevLinkPath}). That is what keeps a folder with
 *   thousands of dependencies cheap.
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
 * straight away.
 *
 * @module services/marketplace/dev-links/dev-link-watcher
 */
import chokidar from 'chokidar';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DevLinkReloadActionSchema,
  type DevLinkRecord,
  type DevLinkReloadAction,
  type DevLinkReloadedEvent,
} from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../../lib/logger.js';
import type { ExtensionsConfig } from '../../extensions/extension-enable-resolution.js';
import { isEnabled } from '../../extensions/extension-enable-resolution.js';
import { mayRunExtensionCode } from '../../extensions/extension-load-policy.js';
import type { ExtensionManager } from '../../extensions/extension-manager.js';
import { isRuntimeStatePath } from '../lib/content-hash.js';
import { devLinkStateOf, readDevLinks } from './registry.js';

/**
 * How long a folder must be quiet before a burst of edits is acted on.
 *
 * An editor's save is several events, a `git checkout` is hundreds, and each
 * is one change to a person. The window restarts on every event, up to
 * {@link DEV_LINK_MAX_WAIT_MS}.
 */
export const DEV_LINK_QUIET_MS = 300;

/**
 * The longest a burst waits, however steadily events keep arriving, so a tool
 * that writes into the folder without pause cannot hold every reload back.
 */
export const DEV_LINK_MAX_WAIT_MS = 3_000;

/**
 * How often the registry is re-read, missing watches opened and each folder
 * compared against what was last acted on. See the module docs.
 */
export const DEV_LINK_REARM_MS = 60_000;

/**
 * How long after chokidar reports `ready` before a watch is treated as live
 * and its folder compared once. `skills-watcher.ts` (`SKILLS_SETTLE_MS`) has
 * the measurement.
 */
export const DEV_LINK_SETTLE_MS = 100;

/** How long a file must stop changing before chokidar reports it (`skills-watcher.ts`). */
const WRITE_STABILITY_MS = 50;

/** @see {@link WRITE_STABILITY_MS} */
const WRITE_POLL_MS = 25;

/** Directory names never watched anywhere inside a linked folder. */
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules']);

/** Where a package carries its extensions, relative to its folder. */
const EXTENSIONS_REL = '.dork/extensions';

/** Folders whose changes the harness projects (besides a root `SKILL.md`). */
const PROJECTED_PREFIXES = ['skills', 'commands', 'hooks', '.dork/tasks'] as const;

/** Of those, the ones that also hold declarations a package runs on its own. */
const DECLARING_PREFIXES = ['skills', 'commands', 'hooks'] as const;

/**
 * The directories the sweep lists, relative to the folder. Each extension's own
 * folder is added per pass. Deeper edits are left to the watch, which in a
 * steady state misses nothing (`skills-watcher.ts`).
 */
const SWEPT_DIRS = [
  '',
  '.claude-plugin',
  '.dork',
  EXTENSIONS_REL,
  '.dork/tasks',
  'skills',
  'commands',
  'hooks',
  'bin',
  'monitors',
] as const;

/** A filesystem event, as chokidar names it. */
export type DevLinkChangeKind = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

/** One change inside a linked folder. */
export interface DevLinkChange {
  /** POSIX path relative to the folder; `''` is the folder itself. */
  rel: string;
  /** What happened to it. */
  kind: DevLinkChangeKind;
}

/** What a burst of changes asks for. */
export interface DevLinkReloadPlan {
  /** Extension folder names (under `.dork/extensions`) to rebuild, sorted. */
  reload: string[];
  /** Re-scan every extension before rebuilding any. */
  refreshExtensions: boolean;
  /** Run a project dev link's harness projection again. */
  projection: boolean;
  /** Refresh the runtime's plugin list and check what the package runs again. */
  plugins: boolean;
}

/**
 * Whether a path inside a linked folder is never watched or acted on: anything
 * under a `.git` or `node_modules` directory, and DorkOS's own runtime state
 * (`isRuntimeStatePath`: saved data, secrets, install records).
 *
 * @param rel - POSIX path relative to the folder.
 */
export function isIgnoredDevLinkPath(rel: string): boolean {
  if (rel === '') return false;
  if (rel.split('/').some((segment) => IGNORED_DIR_NAMES.has(segment))) return true;
  return isRuntimeStatePath(rel);
}

/** Whether `rel` is `prefix` or lies under it. */
function under(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * Decide what a burst of changes asks for. Pure.
 *
 * | Changed path                                         | Asks for                     |
 * | ---------------------------------------------------- | ---------------------------- |
 * | `.dork/extensions/<dir>/**`, `<dir>` known           | rebuild `<dir>`              |
 * | `.dork/extensions/<dir>/extension.json`, known       | re-scan, then rebuild        |
 * | a new or removed `.dork/extensions/<dir>`, or an unknown one | re-scan               |
 * | `skills/**`, `commands/**`, `hooks/**`, root `SKILL.md` | projection and plugins    |
 * | `.dork/tasks/**`                                     | projection                   |
 * | anything else (manifests, `bin/`, servers, monitors) | plugins                      |
 *
 * Skills, commands and hooks ask for both because their frontmatter and files
 * declare hooks the package runs on its own, which global consent re-checks.
 * "Anything else" errs toward checking again: a plugin may name its hooks or
 * servers file anywhere, and a refresh that finds nothing new costs little.
 *
 * @param changes - The burst, in any order.
 * @param knownExtensionDirs - Extension folder names DorkOS already has a
 *   record for, from this linked folder.
 */
export function classifyDevLinkChanges(
  changes: readonly DevLinkChange[],
  knownExtensionDirs: ReadonlySet<string>
): DevLinkReloadPlan {
  const reload = new Set<string>();
  let refreshExtensions = false;
  let projection = false;
  let plugins = false;
  for (const { rel, kind } of changes) {
    if (isIgnoredDevLinkPath(rel)) continue;
    if (under(rel, EXTENSIONS_REL)) {
      const parts = rel.split('/');
      const dir = parts[2];
      if (dir === undefined) {
        refreshExtensions = true;
        continue;
      }
      const known = knownExtensionDirs.has(dir);
      if (parts.length === 3) {
        // The extension's own folder: appearing or going away is a re-scan; a
        // sweep's "something in it changed" is a rebuild when it is known.
        if (kind === 'change' && known) reload.add(dir);
        else refreshExtensions = true;
        continue;
      }
      if (!known) {
        refreshExtensions = true;
        continue;
      }
      if (parts.length === 4 && parts[3] === 'extension.json') refreshExtensions = true;
      reload.add(dir);
      continue;
    }
    if (rel === 'SKILL.md' || PROJECTED_PREFIXES.some((prefix) => under(rel, prefix))) {
      projection = true;
      if (rel === 'SKILL.md' || DECLARING_PREFIXES.some((prefix) => under(rel, prefix))) {
        plugins = true;
      }
      continue;
    }
    plugins = true;
  }
  return { reload: [...reload].sort(), refreshExtensions, projection, plugins };
}

/** What a rebuild of one extension came to. */
export type DevLinkExtensionReload =
  | { outcome: 'reloaded' }
  /** Turned off, or not approved to run: nothing was built or run. */
  | { outcome: 'skipped' }
  | { outcome: 'failed'; error: string };

/** The extension seams the watcher drives. */
export interface DevLinkExtensions {
  /**
   * The extensions DorkOS has a record for that come from this linked folder:
   * each id with its folder name under `.dork/extensions`.
   *
   * @param folder - The linked folder's real path.
   */
  carriedBy(folder: string): Array<{ id: string; dir: string }>;
  /** Re-scan every extension, and wait for the scan to finish. */
  refresh(): Promise<void>;
  /**
   * Rebuild one extension, only when it is turned on and approved to run.
   *
   * @param id - The extension id.
   */
  reload(id: string): Promise<DevLinkExtensionReload>;
}

/** Which dev link a projection or refresh is for. */
export interface DevLinkScopeContext {
  /** Package name. */
  packageName: string;
  /** The project, for a project dev link. */
  projectPath?: string;
}

/** A minimal file watch: what the watcher needs from chokidar. */
export interface DevLinkWatchHandle {
  /** Close the watch. */
  close(): Promise<void>;
}

/** Callbacks a {@link DevLinkWatchFactory} reports through. */
export interface DevLinkWatchListeners {
  /** A filesystem event at an absolute path. */
  onEvent(kind: DevLinkChangeKind, absPath: string): void;
  /** The first scan finished. */
  onReady(): void;
  /** The watch failed. */
  onError(err: unknown): void;
}

/**
 * Open a watch on a folder. The default is chokidar; a test passes a fake.
 *
 * @param folder - The folder's real path.
 * @param ignored - Whether an absolute path inside it is never watched.
 * @param listeners - Where to report.
 */
export type DevLinkWatchFactory = (
  folder: string,
  ignored: (absPath: string) => boolean,
  listeners: DevLinkWatchListeners
) => DevLinkWatchHandle;

/** What {@link DevLinkWatcher} needs. */
export interface DevLinkWatcherDeps {
  /** Resolved DorkOS data directory, where the registry lives. */
  dorkHome: string;
  /** The extension seams. Absent when extensions did not start: edits there do nothing. */
  extensions?: DevLinkExtensions;
  /**
   * Refresh the runtime's plugin list for the dev link's scope and check again
   * what the package runs on its own (global consent). Fire-and-forget; must
   * not throw.
   */
  refreshPlugins: (ctx: DevLinkScopeContext) => void;
  /**
   * Run a project's harness projection through its consent seam, which
   * withholds and asks about new hooks. May stay pending while a card is open.
   */
  reproject: (ctx: DevLinkScopeContext & { projectPath: string }) => Promise<void>;
  /** Broadcast one dev link's reload on the global event stream. */
  broadcast: (event: DevLinkReloadedEvent) => void;
  /** Override {@link DEV_LINK_QUIET_MS}. @internal For tests. */
  quietMs?: number;
  /** Override {@link DEV_LINK_MAX_WAIT_MS}. @internal For tests. */
  maxWaitMs?: number;
  /** Override {@link DEV_LINK_REARM_MS}; `0` switches the timer off. @internal For tests. */
  rearmMs?: number;
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
  handle?: DevLinkWatchHandle;
  /** Set when the watch reported an error; the sweep replaces it. */
  dead: boolean;
  /** Resolves once the watch has settled. */
  ready: Promise<void>;
  /** Changes not yet acted on. */
  pending: DevLinkChange[];
  /** The quiet-period timer. */
  timer?: NodeJS.Timeout;
  /** When the current burst began, for {@link DEV_LINK_MAX_WAIT_MS}. */
  burstStartedAt?: number;
  /** The burst being acted on now. */
  inFlight?: Promise<void>;
  /** The listing last acted on, by swept directory. */
  shape?: Map<string, string>;
}

/** One dev link's projection lane: at most one running and one more owed. */
interface ProjectionLane {
  inFlight?: Promise<void>;
  again: boolean;
}

/** The stable string key of one dev link. */
function keyOf(record: DevLinkKey): string {
  return JSON.stringify([record.name, record.scope, record.projectPath ?? null]);
}

/** Whether a record still names the same dev link and folder. */
function sameRecord(a: DevLinkRecord, b: DevLinkRecord): boolean {
  return keyOf(a) === keyOf(b) && a.target === b.target && a.slot === b.slot;
}

/** POSIX path of `abs` relative to `folder`, or `null` when it is outside. */
function relativeTo(folder: string, abs: string): string | null {
  const rel = path.relative(folder, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * A cheap listing of a folder's meaningful directories: each one's entries
 * with their modification time and size, ignored paths left out. Changes
 * whenever an entry appears, goes or is rewritten at those levels.
 */
async function shapeOf(folder: string): Promise<Map<string, string>> {
  const shape = new Map<string, string>();
  const extensionDirs = await readdir(path.join(folder, EXTENSIONS_REL), {
    withFileTypes: true,
  }).catch(() => []);
  const dirs = [
    ...SWEPT_DIRS,
    ...extensionDirs
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${EXTENSIONS_REL}/${entry.name}`),
  ];
  for (const rel of dirs) {
    const abs = path.join(folder, rel);
    const entries = await readdir(abs).catch(() => null);
    if (entries === null) {
      shape.set(rel, '-');
      continue;
    }
    const parts: string[] = [];
    for (const name of entries.sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (isIgnoredDevLinkPath(childRel)) continue;
      const stats = await lstat(path.join(abs, name)).catch(() => null);
      parts.push(stats ? `${name}:${stats.mtimeMs}:${stats.size}` : `${name}:?`);
    }
    shape.set(rel, parts.join('|'));
  }
  return shape;
}

/** The swept directories whose listing differs, as changes to act on. */
function shapeChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): DevLinkChange[] {
  const changes: DevLinkChange[] = [];
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(rel);
    const is = after.get(rel);
    if (was === is) continue;
    // An extension folder that appeared or went away is a re-scan; any other
    // difference is "something in it changed".
    const appeared = was === undefined || was === '-';
    const vanished = is === undefined || is === '-';
    changes.push({ rel, kind: appeared ? 'addDir' : vanished ? 'unlinkDir' : 'change' });
  }
  return changes;
}

/** The default watch: chokidar over the whole folder, links not followed. */
const chokidarWatch: DevLinkWatchFactory = (folder, ignored, listeners) => {
  const watcher = chokidar.watch(folder, {
    persistent: true,
    ignoreInitial: true,
    // A link inside the working folder is not followed: it could lead out of
    // the folder, or back into it.
    followSymlinks: false,
    ignored: (absPath: string) => ignored(absPath),
    awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
  });
  watcher.on('all', (eventName, absPath) => {
    if (
      eventName === 'add' ||
      eventName === 'addDir' ||
      eventName === 'change' ||
      eventName === 'unlink' ||
      eventName === 'unlinkDir'
    ) {
      listeners.onEvent(eventName, absPath);
    }
  });
  watcher.on('ready', () => listeners.onReady());
  watcher.on('error', (err) => listeners.onError(err));
  return { close: () => watcher.close() };
};

/** The order actions are reported in. */
const ACTION_ORDER = DevLinkReloadActionSchema.options;

/**
 * Watches every dev link in force and drives the existing reload seams. One
 * instance per server; {@link start} at boot, {@link stop} at shutdown.
 */
export class DevLinkWatcher {
  private readonly folders = new Map<string, WatchedFolder>();
  /** Folders whose watch closed because the folder went missing, for a catch-up on return. */
  private readonly lost = new Set<string>();
  private readonly lanes = new Map<string, ProjectionLane>();
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
    this.watch = deps.watch ?? chokidarWatch;
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
   *
   * @param record - Which dev link.
   */
  hold(record: DevLinkKey): Promise<void> {
    return this.serialize(async () => {
      const key = keyOf(record);
      this.held.add(key);
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
      if (!watched.handle || watched.dead || !watched.shape) continue;
      const changes = shapeChanges(watched.shape, await shapeOf(watched.folder));
      if (changes.length > 0) this.enqueue(watched, changes);
    }
  }

  /**
   * Act on everything pending now and wait for it.
   *
   * @internal For tests: it collapses the quiet period.
   */
  async flush(): Promise<void> {
    for (const watched of this.folders.values()) {
      if (watched.timer) {
        clearTimeout(watched.timer);
        watched.timer = undefined;
        this.fire(watched);
      }
    }
    await Promise.all([...this.folders.values()].map((watched) => watched.inFlight));
  }

  /**
   * Wait for every projection this watcher started.
   *
   * @internal For tests.
   */
  async projectionsIdle(): Promise<void> {
    await Promise.all([...this.lanes.values()].map((lane) => lane.inFlight));
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
    for (const key of [...this.lastReloads.keys()]) {
      if (!recorded.has(key)) this.lastReloads.delete(key);
    }

    const wanted = new Map<string, DevLinkRecord[]>();
    for (const record of records) {
      if (this.held.has(keyOf(record))) continue;
      const state = await devLinkStateOf(record);
      if (state === 'folder-missing') this.lost.add(record.target);
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
        watched = { folder, records: [], dead: false, ready: Promise.resolve(), pending: [] };
        this.folders.set(folder, watched);
      }
      watched.records = folderRecords;
      if (watched.handle && !watched.dead) continue;
      // A folder that went missing and is back, or a watch that died: what
      // changed meanwhile was never seen, so everything is checked again.
      const catchUp = this.lost.delete(folder) || watched.dead;
      await this.arm(watched, catchUp);
    }
  }

  /** Open (or replace) the watch on one folder. */
  private async arm(watched: WatchedFolder, catchUp: boolean): Promise<void> {
    if (watched.handle) await watched.handle.close().catch(() => undefined);
    watched.handle = undefined;
    watched.dead = false;
    // Read before the watch opens, so a write in the moments after is a
    // difference the settle comparison finds.
    const before = await shapeOf(watched.folder);
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
        void this.compareAfterSettle(watched, before).finally(settled);
      }, settleMs);
      timer.unref?.();
    };
    watched.handle = this.watch(
      watched.folder,
      (absPath) => {
        const rel = relativeTo(watched.folder, absPath);
        return rel !== null && isIgnoredDevLinkPath(rel);
      },
      {
        onEvent: (kind, absPath) => {
          const rel = relativeTo(watched.folder, absPath);
          if (rel === null || isIgnoredDevLinkPath(rel)) return;
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
    if (catchUp) {
      this.enqueue(
        watched,
        [...before.keys()].map((rel) => ({ rel, kind: 'change' as const }))
      );
    }
  }

  /** The one comparison right after a watch settles. */
  private async compareAfterSettle(
    watched: WatchedFolder,
    before: ReadonlyMap<string, string>
  ): Promise<void> {
    if (this.stopped || this.folders.get(watched.folder) !== watched || !watched.handle) return;
    const changes = shapeChanges(watched.shape ?? before, await shapeOf(watched.folder));
    if (changes.length > 0) this.enqueue(watched, changes);
  }

  /** Add changes to a folder's burst and (re)start its quiet period. */
  private enqueue(watched: WatchedFolder, changes: readonly DevLinkChange[]): void {
    if (this.stopped || this.folders.get(watched.folder) !== watched) return;
    watched.pending.push(...changes);
    // A burst is being acted on: these wait, and one more pass runs after it.
    if (watched.inFlight) return;
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

  /** Start acting on a folder's burst, and run once more if more arrived meanwhile. */
  private fire(watched: WatchedFolder): void {
    if (watched.inFlight || watched.pending.length === 0) return;
    watched.burstStartedAt = undefined;
    const run = (async () => {
      try {
        while (watched.pending.length > 0 && !this.stopped) {
          const changes = watched.pending.splice(0);
          await this.act(watched, changes);
        }
      } catch (err) {
        logger.warn('[Marketplace] A dev link reload failed', { folder: watched.folder, err });
      } finally {
        watched.inFlight = undefined;
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
          if (states.includes('folder-missing')) this.lost.add(watched.folder);
        }
        await this.close(watched);
      });
      return;
    }
    watched.shape = await shapeOf(watched.folder);

    const extensions = this.deps.extensions;
    const carried = (): Map<string, string[]> => {
      const byDir = new Map<string, string[]>();
      for (const { id, dir } of extensions?.carriedBy(watched.folder) ?? []) {
        byDir.set(dir, [...(byDir.get(dir) ?? []), id]);
      }
      return byDir;
    };
    let known = carried();
    const plan = classifyDevLinkChanges(changes, new Set(known.keys()));
    const actions = new Set<DevLinkReloadAction>();
    const errors: string[] = [];

    if (extensions && (plan.refreshExtensions || plan.reload.length > 0)) {
      if (plan.refreshExtensions) {
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
        const result = await extensions
          .reload(id)
          .catch((err): DevLinkExtensionReload => ({ outcome: 'failed', error: messageOf(err) }));
        if (result.outcome === 'skipped') continue;
        actions.add('extension');
        if (result.outcome === 'failed') errors.push(`${id} didn't build: ${result.error}`);
      }
    }

    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    for (const record of live) {
      const recordActions = new Set(actions);
      const context: DevLinkScopeContext = {
        packageName: record.name,
        ...(record.projectPath !== undefined && { projectPath: record.projectPath }),
      };
      if (plan.plugins) {
        try {
          this.deps.refreshPlugins(context);
        } catch (err) {
          logger.warn('[Marketplace] Refreshing plugins after a dev link edit failed', { err });
        }
        recordActions.add('plugins');
      }
      // Global packages are not projected by DorkOS (the same as an install,
      // `runAutoProjection`); in a project, a changed declaration also runs
      // the projection, which is where a new hook is withheld and asked about.
      if ((plan.projection || plan.plugins) && record.projectPath !== undefined) {
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
    const lane = this.lanes.get(key) ?? { again: false };
    this.lanes.set(key, lane);
    if (lane.inFlight) {
      lane.again = true;
      return;
    }
    lane.inFlight = (async () => {
      do {
        lane.again = false;
        try {
          await this.deps.reproject({ packageName: record.name, projectPath });
        } catch (err) {
          logger.warn('[Marketplace] Projecting after a dev link edit failed', { err });
        }
      } while (lane.again && !this.stopped);
      lane.inFlight = undefined;
      this.lanes.delete(key);
    })();
  }

  /** Close one folder's watch and forget it. */
  private async close(watched: WatchedFolder): Promise<void> {
    if (watched.timer) clearTimeout(watched.timer);
    watched.timer = undefined;
    watched.pending = [];
    if (this.folders.get(watched.folder) === watched) this.folders.delete(watched.folder);
    const handle = watched.handle;
    watched.handle = undefined;
    await handle?.close().catch(() => undefined);
  }
}

/** One line for an error of any shape. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What {@link devLinkExtensionsOf} needs from the extension manager. */
export type DevLinkExtensionManager = Pick<
  ExtensionManager,
  'listRecords' | 'reloadExtension' | 'requestRefresh' | 'whenIdle'
>;

/**
 * The extension seams over the real {@link ExtensionManager}: the same calls
 * `reload_extensions` makes, gated on the extension being on and approved.
 *
 * @param manager - The extension manager.
 * @param opts.config - Reads `config.extensions` (on/off lists and approvals).
 * @param opts.announce - Tells clients an extension rebuilt
 *   (`broadcastExtensionReloaded`), so they load the new bundle.
 */
export function devLinkExtensionsOf(
  manager: DevLinkExtensionManager,
  opts: { config: () => ExtensionsConfig; announce: (ids: string[]) => void }
): DevLinkExtensions {
  return {
    carriedBy: (folder) =>
      manager
        .listRecords()
        .filter((record) => record.devLink?.path === folder)
        .map((record) => ({ id: record.id, dir: path.basename(record.path) })),
    refresh: async () => {
      manager.requestRefresh();
      await manager.whenIdle();
    },
    reload: async (id) => {
      const record = manager.listRecords().find((candidate) => candidate.id === id);
      const config = opts.config();
      // A dev-linked copy is never a core extension, so no core table is needed
      // to answer whether it is on.
      if (
        !record ||
        record.origin === 'core' ||
        !isEnabled(id, config, new Map()) ||
        !mayRunExtensionCode(record, config)
      ) {
        return { outcome: 'skipped' };
      }
      const result = await manager.reloadExtension(id);
      if (result.status !== 'compiled') {
        return { outcome: 'failed', error: result.error?.message ?? 'it did not compile' };
      }
      opts.announce([id]);
      return { outcome: 'reloaded' };
    },
  };
}
