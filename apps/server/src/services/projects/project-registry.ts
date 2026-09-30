/**
 * Every project the server knows, each with one short, stable name (spec
 * `flow-multiproject` §6.1, N4).
 *
 * A project is a git main checkout ({@link resolveProjectRoot}). The registry
 * remembers the ones it has seen: every session folder the server resolves,
 * every agent's folder, every workspace source and every project a package was
 * installed into. Extensions may add one with `ctx.projects.report` (or name one
 * with `ctx.projects.resolve`), and a person may look one up; such a root is
 * second-class. It is stored as `reported`, it never widens where core looks for
 * extension code, it stays out of the person's project list, and seeing it
 * later as a session, agent, workspace or install folder upgrades it to `seen`.
 * An extension can name at most {@link MAX_REPORTED_ROOTS_PER_EXTENSION} roots,
 * so it cannot squat names at scale.
 *
 * ## The boundary
 *
 * Anything an extension or a person names is checked twice: the folder they
 * gave, and the root git answers with. A worktree inside the boundary whose
 * repository lives outside it (or a `.git` file pointing out) would otherwise
 * reveal and register a folder the boundary exists to keep out.
 *
 * ## Names
 *
 * A name is the root's folder name with every character outside
 * `[A-Za-z0-9._-]` replaced by `-`. When that is taken, the newcomer gets
 * `name~parent` (the parent folder's name, same rule), then `name~parent-2`
 * and so on. A name is assigned once and never changes, so `/x/flow/p/dorkos`
 * keeps meaning the same project; the project that had a name first keeps it.
 *
 * ## Cost
 *
 * The rows live in memory (a machine knows tens of projects, not thousands) and
 * write through to `known_projects`; a row storage refuses is never kept in
 * memory, so a name in memory is always the name on disk. Seeding records a
 * batch in sorted root order after every origin lookup, so first-boot names do
 * not depend on which git call finished first. Resolving a folder costs one `git` the
 * first time and nothing after. `lastSeenAt` is written at most every ten
 * minutes per project, so a busy session does not write on every turn.
 *
 * @module services/projects/project-registry
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import type { ProjectInfo, ProjectRef } from '@dorkos/shared/project-schemas';

import { validateBoundary } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { runGit } from '../workspace/providers/git.js';
import type {
  KnownProject,
  KnownProjectReporter,
  KnownProjectsPort,
} from './known-projects-store.js';
import { parseOriginRepo } from './origin-repo.js';
import { peekProjectRoot, resolveProjectRoot } from './resolve-project-root.js';

/** How often a project's `lastSeenAt` is written, at most. */
const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60_000;

/** How often {@link ProjectRegistry.list} re-reads the seed sources, at most. */
const SOURCES_REFRESH_INTERVAL_MS = 60_000;

/** How long an extension's scoped list is reused before its folders are checked again. */
const EXTENSION_SCOPE_TTL_MS = 60_000;

/**
 * The most roots one extension may name (report or resolve) that core had not
 * seen. Past it, naming a new root answers null and records nothing.
 */
export const MAX_REPORTED_ROOTS_PER_EXTENSION = 200;

/** Timeout for `git remote get-url origin`. */
const ORIGIN_GIT_TIMEOUT_MS = 5_000;

/** The folders a registry is seeded from: agents, workspaces and installs. */
export type ProjectSources = () => Promise<string[]> | string[];

/** The collaborators a {@link ProjectRegistry} uses; tests replace them. */
export interface ProjectRegistryDeps {
  /** The main checkout of a folder, or null (`resolveProjectRoot`). */
  resolveRoot: (cwd: string) => Promise<string | null>;
  /** The cached main checkout of a folder, without running git. */
  peekRoot: (cwd: string) => string | null | undefined;
  /** `owner/name` of a root's `origin` remote, or null. Never throws. */
  readOriginRepo: (root: string) => Promise<string | null>;
  /** Whether a folder exists right now. */
  exists: (dir: string) => Promise<boolean>;
  /**
   * The folder, canonical, when it is inside the directory boundary.
   *
   * @throws When it is outside the boundary.
   */
  checkBoundary: (dir: string) => Promise<string>;
  /** The clock, in epoch ms. */
  now: () => number;
}

async function readOriginRepoFromGit(root: string): Promise<string | null> {
  try {
    return parseOriginRepo(
      await runGit(['remote', 'get-url', 'origin'], root, { timeoutMs: ORIGIN_GIT_TIMEOUT_MS })
    );
  } catch {
    return null;
  }
}

async function folderExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

const defaultDeps: ProjectRegistryDeps = {
  resolveRoot: resolveProjectRoot,
  peekRoot: peekProjectRoot,
  readOriginRepo: readOriginRepoFromGit,
  exists: folderExists,
  checkBoundary: (dir) => validateBoundary(dir),
  now: Date.now,
};

/**
 * A folder name in the characters a project name may hold.
 *
 * @param segment - One path segment.
 * @returns The segment with every character outside `[A-Za-z0-9._-]` as `-`.
 */
export function sanitizeNameSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * The name a new root gets, given the names already taken.
 *
 * @param root - The new project's root.
 * @param isTaken - Whether a name already belongs to another project.
 */
export function assignProjectName(root: string, isTaken: (name: string) => boolean): string {
  const base = sanitizeNameSegment(path.basename(root)) || 'project';
  if (!isTaken(base)) return base;
  const parent = sanitizeNameSegment(path.basename(path.dirname(root))) || 'root';
  const withParent = `${base}~${parent}`;
  if (!isTaken(withParent)) return withParent;
  for (let n = 2; ; n++) {
    const candidate = `${withParent}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

function toRef(project: KnownProject): ProjectRef {
  return { root: project.root, name: project.name };
}

function toInfo(project: KnownProject): ProjectInfo {
  return {
    root: project.root,
    name: project.name,
    originRepo: project.originRepo,
    lastSeenAt: project.lastSeenAt,
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/**
 * Whether a root holds a copy of an extension: a `.dork/extensions/<id>`
 * folder, or one inside a plugin at `.dork/plugins/<plugin>/.dork/extensions/<id>`.
 *
 * @param root - A project root.
 * @param extensionId - The extension's id.
 */
export async function holdsExtensionCopy(root: string, extensionId: string): Promise<boolean> {
  if (await folderExists(path.join(root, '.dork', 'extensions', extensionId))) return true;
  let plugins: string[];
  try {
    plugins = await fs.readdir(path.join(root, '.dork', 'plugins'));
  } catch {
    return false;
  }
  for (const plugin of plugins) {
    // A half-finished or backed-up install beside a plugin is not a copy.
    if (isInstallSiblingName(plugin)) continue;
    const copy = path.join(root, '.dork', 'plugins', plugin, '.dork', 'extensions', extensionId);
    if (await folderExists(copy)) return true;
  }
  return false;
}

/** How a root became known when it is recorded. */
type RecordHow = 'seen' | 'reported';

/** What {@link ProjectRegistry.resolveWithin} answers: a project, none, or refused. */
export type BoundedResolution = ProjectRef | null | 'outside';

/** Every project the server knows. See the module documentation. */
export class ProjectRegistry {
  private readonly deps: ProjectRegistryDeps;
  private store: KnownProjectsPort | undefined;
  private readonly byRoot = new Map<string, KnownProject>();
  private readonly names = new Set<string>();
  /** Roots being recorded right now, so two callers never insert one root twice. */
  private readonly recording = new Map<string, Promise<KnownProject>>();
  /** When each root's `lastSeenAt` was last written. */
  private readonly lastWritten = new Map<string, number>();
  /** Root to the extensions that named it, and how. */
  private readonly reporters = new Map<string, Map<string, KnownProjectReporter['kind']>>();
  /**
   * New roots an extension is naming right now, reserved before the record's
   * await so concurrent calls cannot all pass the cap check at once.
   */
  private readonly reserved = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();
  private sources: ProjectSources | undefined;
  private sourcesReadAt: number | undefined;
  private sourcesRead: Promise<void> | undefined;
  private readonly scoped = new Map<string, { at: number; roots: Promise<Set<string>> }>();

  /**
   * Build a registry.
   *
   * @param overrides - Collaborators to replace (tests).
   */
  constructor(overrides: Partial<ProjectRegistryDeps> = {}) {
    this.deps = { ...defaultDeps, ...overrides };
  }

  /**
   * Load the stored projects and write through to `store` from now on.
   * Called once at boot, BEFORE extensions start: a name handed out before the
   * stored names are loaded could belong to a saved project.
   *
   * @param store - Where projects are kept.
   */
  attachStore(store: KnownProjectsPort): void {
    // Anything recorded before the store existed is kept only if storage takes
    // it; the stored rows win, since their names came first.
    const early = [...this.byRoot.values()];
    const earlyReporters = [...this.reporters.entries()];
    this.store = store;
    this.byRoot.clear();
    this.names.clear();
    this.reporters.clear();
    for (const project of store.all()) {
      this.byRoot.set(project.root, project);
      this.names.add(project.name);
    }
    for (const reporter of store.reporters()) this.noteReporter(reporter);
    for (const project of early) {
      if (this.byRoot.has(project.root)) continue;
      try {
        this.insert({
          ...project,
          name: assignProjectName(project.root, (name) => this.names.has(name)),
        });
      } catch (err) {
        this.warn(`could not record ${project.root}`, err);
      }
    }
    for (const [root, byExtension] of earlyReporters) {
      for (const [extensionId, kind] of byExtension) this.addReporter(root, extensionId, kind);
    }
  }

  /**
   * Where the registry learns about agents, workspaces and installs. Read at
   * once (the boot seed) and again by {@link list}, at most once a minute, so a
   * newly registered agent or install shows up without a restart.
   *
   * @param sources - Returns the folders to seed from.
   */
  setSources(sources: ProjectSources): Promise<void> {
    this.sources = sources;
    this.sourcesReadAt = undefined;
    return this.refreshSources();
  }

  /**
   * The project a folder belongs to, remembered as seen. For core's own
   * folders only (a session, agent, workspace or install folder); anything a
   * person or an extension names goes through {@link resolveWithin}.
   *
   * @param cwd - Any absolute folder.
   * @returns The project, or null when the folder is in no repository.
   */
  async resolve(cwd: string): Promise<ProjectRef | null> {
    const root = await this.deps.resolveRoot(cwd);
    if (root === null) return null;
    return toRef(await this.remember(root, 'seen'));
  }

  /**
   * The project of a folder the registry has already resolved, without
   * running git or writing anything. A folder it has not resolved yet answers
   * `undefined` and is resolved in the background, so the next call knows.
   *
   * For synchronous callers that stamp a live event, where a git call would
   * hold the event up (spec `flow-multiproject` §6.2).
   *
   * @param cwd - Any absolute folder.
   * @returns The project, `null` for no project, or `undefined` when not known yet.
   */
  peek(cwd: string): ProjectRef | null | undefined {
    const root = this.deps.peekRoot(cwd);
    if (root === null) return null;
    const known = root === undefined ? undefined : this.byRoot.get(root);
    if (known) return toRef(known);
    void this.resolve(cwd).catch((err) => this.warn('could not resolve a folder', err));
    return undefined;
  }

  /**
   * The project of a folder a person or an extension named, never promoting
   * it to seen (`GET /api/projects/resolve`, `ctx.projects.resolve`).
   *
   * Both the folder and the root git answers with must be inside the
   * directory boundary. A root core had not seen is recorded as `reported`;
   * for an extension it counts against its cap, and it does not join the
   * extension's own list (only {@link report} does that).
   *
   * @param dir - Any folder.
   * @param extensionId - The extension asking, or undefined for a person.
   * @returns The project, null (no repository, or the extension is at its
   *   cap), or `'outside'` when the folder or its root is outside the boundary.
   */
  async resolveWithin(dir: string, extensionId?: string): Promise<BoundedResolution> {
    const root = await this.boundedRoot(dir);
    if (root === 'outside' || root === null) return root;
    const known = this.byRoot.get(root);
    if (known) return toRef(known);
    if (extensionId === undefined) return toRef(await this.remember(root, 'reported'));
    return this.withSlot(extensionId, root, async () => {
      const project = await this.remember(root, 'reported');
      this.addReporter(root, extensionId, 'resolve');
      return toRef(project);
    });
  }

  /**
   * An extension's hint about a project core may not have seen. The folder and
   * its root must pass the directory boundary, the folder must be inside a git
   * repository, and the extension must be under its cap for new roots;
   * otherwise nothing is recorded.
   *
   * @param dir - Any folder inside the project.
   * @param extensionId - The extension reporting it.
   * @returns The project, or null.
   */
  async report(dir: string, extensionId: string): Promise<ProjectRef | null> {
    const root = await this.boundedRoot(dir);
    if (root === 'outside' || root === null) return null;
    return this.withSlot(extensionId, root, async () => {
      const project = await this.remember(root, 'reported');
      this.addReporter(root, extensionId, 'report');
      return toRef(project);
    });
  }

  /**
   * Every project the person works in whose folder exists, by name: the ones
   * core has seen. A root only an extension or a one-off lookup named stays
   * out until it is seen. Folders that are gone are hidden and kept (a drive
   * may be unplugged).
   */
  async list(): Promise<ProjectInfo[]> {
    await this.refreshSources();
    const present = await this.present();
    return present
      .filter((p) => p.source === 'seen')
      .map(toInfo)
      .sort(byName);
  }

  /**
   * The projects an extension may see (spec `flow-multiproject` §6.1): the
   * ones that hold a copy of it, and the ones it reported itself. An extension
   * does not learn every folder the person works in.
   *
   * @param extensionId - The asking extension.
   */
  async listForExtension(extensionId: string): Promise<ProjectInfo[]> {
    await this.refreshSources();
    const present = await this.present();
    const cached = this.scoped.get(extensionId);
    let roots: Promise<Set<string>>;
    if (cached && this.deps.now() - cached.at < EXTENSION_SCOPE_TTL_MS) {
      roots = cached.roots;
    } else {
      roots = this.scopeFor(extensionId, present);
      this.scoped.set(extensionId, { at: this.deps.now(), roots });
    }
    const allowed = await roots;
    return present
      .filter((p) => allowed.has(p.root))
      .map(toInfo)
      .sort(byName);
  }

  /**
   * The known project stored for a root, or undefined.
   *
   * @param root - A project root, canonical.
   */
  get(root: string): ProjectInfo | undefined {
    const project = this.byRoot.get(root);
    return project ? toInfo(project) : undefined;
  }

  /**
   * Whether a root is known only because an extension or a lookup named it.
   * Such a root must never widen where core looks for extension code (§6.1).
   *
   * @param root - A project root, canonical.
   */
  isReportedOnly(root: string): boolean {
    return this.byRoot.get(root)?.source === 'reported';
  }

  /**
   * Call `listener` whenever a project is added or changes how it is known.
   *
   * @param listener - Called with no arguments.
   * @returns Unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The root of a named folder, with the boundary applied to both ends, and
   * nothing recorded: no `reported` row, no reporter, no cap slot. For a caller
   * that only accepts projects already known (starting work, spec §7.7), where
   * a refusal must leave no trace.
   *
   * @param dir - Any folder.
   * @returns The canonical root, null (no repository), or `'outside'`.
   */
  rootWithin(dir: string): Promise<string | null | 'outside'> {
    return this.boundedRoot(dir);
  }

  /** The root of a named folder, with the boundary applied to both ends. */
  private async boundedRoot(dir: string): Promise<string | null | 'outside'> {
    let checked: string;
    try {
      checked = await this.deps.checkBoundary(dir);
    } catch {
      return 'outside';
    }
    const root = await this.deps.resolveRoot(checked);
    if (root === null) return null;
    try {
      await this.deps.checkBoundary(root);
    } catch {
      return 'outside';
    }
    return root;
  }

  /**
   * Run `name` holding one of the extension's cap slots for `root`, or answer
   * null when the extension is at its cap. The slot is taken synchronously,
   * before any await, and given back once the call settles (kept only as the
   * reporter row it became), so a burst of concurrent calls cannot overshoot.
   */
  private async withSlot<T>(
    extensionId: string,
    root: string,
    name: () => Promise<T>
  ): Promise<T | null> {
    if (this.reporters.get(root)?.has(extensionId)) return name();
    let pending = this.reserved.get(extensionId);
    if (pending?.has(root)) return name();
    if (this.namedBy(extensionId) + (pending?.size ?? 0) >= MAX_REPORTED_ROOTS_PER_EXTENSION) {
      return null;
    }
    if (!pending) this.reserved.set(extensionId, (pending = new Set()));
    pending.add(root);
    try {
      return await name();
    } finally {
      pending.delete(root);
      if (pending.size === 0) this.reserved.delete(extensionId);
    }
  }

  /** How many roots an extension has named. */
  private namedBy(extensionId: string): number {
    let named = 0;
    for (const byExtension of this.reporters.values()) if (byExtension.has(extensionId)) named++;
    return named;
  }

  private noteReporter(reporter: Pick<KnownProjectReporter, 'root' | 'extensionId' | 'kind'>) {
    let byExtension = this.reporters.get(reporter.root);
    if (!byExtension) this.reporters.set(reporter.root, (byExtension = new Map()));
    if (byExtension.get(reporter.extensionId) !== 'report') {
      byExtension.set(reporter.extensionId, reporter.kind);
    }
  }

  /** Record that an extension named a root; persisted first, then kept. */
  private addReporter(root: string, extensionId: string, kind: KnownProjectReporter['kind']) {
    const current = this.reporters.get(root)?.get(extensionId);
    if (current === 'report' || current === kind) return;
    const reporter: KnownProjectReporter = {
      root,
      extensionId,
      kind,
      reportedAt: new Date(this.deps.now()).toISOString(),
    };
    try {
      this.store?.addReporter(reporter);
    } catch (err) {
      this.warn(`could not record that ${extensionId} named ${root}`, err);
      return;
    }
    this.noteReporter(reporter);
    if (kind === 'report') this.scoped.delete(extensionId);
  }

  private async scopeFor(extensionId: string, present: KnownProject[]): Promise<Set<string>> {
    const allowed = new Set<string>();
    await Promise.all(
      present.map(async (project) => {
        if (
          this.reporters.get(project.root)?.get(extensionId) === 'report' ||
          (await holdsExtensionCopy(project.root, extensionId))
        ) {
          allowed.add(project.root);
        }
      })
    );
    return allowed;
  }

  private async present(): Promise<KnownProject[]> {
    const projects = [...this.byRoot.values()];
    const exists = await Promise.all(projects.map((p) => this.deps.exists(p.root)));
    return projects.filter((_, i) => exists[i]);
  }

  private refreshSources(): Promise<void> {
    const sources = this.sources;
    if (!sources) return Promise.resolve();
    if (this.sourcesRead) return this.sourcesRead;
    const now = this.deps.now();
    if (
      this.sourcesReadAt !== undefined &&
      now - this.sourcesReadAt < SOURCES_REFRESH_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    this.sourcesReadAt = now;
    this.sourcesRead = (async () => {
      try {
        const folders = [...new Set(await sources())].filter((dir) => path.isAbsolute(dir));
        await this.seedBatch(folders);
      } catch (err) {
        this.warn('could not read the folders to seed projects from', err);
      } finally {
        this.sourcesRead = undefined;
      }
    })();
    return this.sourcesRead;
  }

  /**
   * Record a batch of core folders as seen, deterministically: every root and
   * origin is looked up first, then new roots are named in sorted root order,
   * so which project gets a contested name does not depend on git timing.
   */
  private async seedBatch(folders: string[]): Promise<void> {
    const roots = await Promise.all(
      folders.map((dir) =>
        this.deps.resolveRoot(dir).catch((err) => {
          this.warn(`could not resolve ${dir}`, err);
          return null;
        })
      )
    );
    const distinct = [...new Set(roots.filter((root): root is string => root !== null))].sort();
    const fresh = distinct.filter((root) => !this.byRoot.has(root) && !this.recording.has(root));
    const origins = await Promise.all(fresh.map((root) => this.deps.readOriginRepo(root)));
    fresh.forEach((root, i) => {
      if (this.byRoot.has(root) || this.recording.has(root)) return;
      try {
        this.insert(this.newProject(root, 'seen', origins[i] ?? null));
      } catch (err) {
        this.learnFromStore();
        this.warn(`could not record ${root}`, err);
      }
    });
    for (const root of distinct) {
      const project = this.byRoot.get(root);
      if (project) this.touch(project, 'seen');
    }
  }

  private remember(root: string, how: RecordHow): Promise<KnownProject> {
    const existing = this.byRoot.get(root);
    if (existing) return Promise.resolve(this.touch(existing, how));
    const inFlight = this.recording.get(root);
    if (inFlight) return inFlight.then((project) => this.touch(project, how));
    const recorded = this.record(root, how).finally(() => this.recording.delete(root));
    this.recording.set(root, recorded);
    return recorded;
  }

  private async record(root: string, how: RecordHow): Promise<KnownProject> {
    const originRepo = await this.deps.readOriginRepo(root);
    // A batch may have recorded it while the origin was read.
    const meanwhile = this.byRoot.get(root);
    if (meanwhile) return this.touch(meanwhile, how);
    const project = this.newProject(root, how, originRepo);
    try {
      this.insert(project);
    } catch (err) {
      // Another server process on the same database may have recorded this
      // root, or taken this name, since the rows were loaded. Learn its rows so
      // the next try picks a free name instead of repeating the clash.
      this.learnFromStore();
      const adopted = this.byRoot.get(root);
      if (adopted) return this.touch(adopted, how);
      throw err;
    }
    return project;
  }

  /** Merge rows another process wrote into memory; never renames a known one. */
  private learnFromStore(): void {
    if (!this.store) return;
    try {
      for (const project of this.store.all()) {
        if (this.byRoot.has(project.root)) continue;
        this.byRoot.set(project.root, project);
        this.names.add(project.name);
      }
      for (const reporter of this.store.reporters()) this.noteReporter(reporter);
    } catch (err) {
      this.warn('could not re-read the saved projects', err);
    }
  }

  private newProject(root: string, how: RecordHow, originRepo: string | null): KnownProject {
    const at = new Date(this.deps.now()).toISOString();
    return {
      root,
      name: assignProjectName(root, (name) => this.names.has(name)),
      originRepo,
      source: how,
      firstSeenAt: at,
      lastSeenAt: at,
    };
  }

  /**
   * Store a new project, then keep it in memory. Storage first: a row it
   * refuses (a clash, a full disk) is never held under a name the table does
   * not have, so the throw reaches the caller and nothing is kept.
   */
  private insert(project: KnownProject): void {
    this.store?.insert(project);
    this.byRoot.set(project.root, project);
    this.names.add(project.name);
    this.lastWritten.set(project.root, this.deps.now());
    this.changed();
  }

  private touch(project: KnownProject, how: RecordHow): KnownProject {
    const now = this.deps.now();
    const upgrade = how === 'seen' && project.source === 'reported';
    const stale = now - (this.lastWritten.get(project.root) ?? 0) >= LAST_SEEN_WRITE_INTERVAL_MS;
    if (!upgrade && !stale) return project;
    const lastSeenAt = new Date(now).toISOString();
    const patch = { lastSeenAt, ...(upgrade ? { source: 'seen' as const } : {}) };
    try {
      this.store?.update(project.root, patch);
    } catch (err) {
      // Memory keeps what storage has; the next sighting tries again.
      this.warn(`could not update ${project.root}`, err);
      return project;
    }
    const next: KnownProject = { ...project, ...patch };
    this.byRoot.set(project.root, next);
    this.lastWritten.set(project.root, now);
    if (upgrade) this.changed();
    return next;
  }

  private changed(): void {
    this.scoped.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.warn('a change listener threw', err);
      }
    }
  }

  private warn(message: string, err: unknown): void {
    logger.warn(`[project-registry] ${message}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The server's one project registry. Boot attaches its store and sources. */
export const projectRegistry = new ProjectRegistry();

/**
 * The project of each folder, resolved once per distinct folder through the
 * server's registry (and remembered as seen). For list routes that stamp
 * `project` on rows they already hold (spec `flow-multiproject` §6.2). A
 * folder that fails to resolve reads as no project; it never fails the list.
 *
 * @param folders - Absolute folders; repeats and empty strings are fine.
 * @returns Folder to its project, or null.
 */
export async function projectsOfFolders(
  folders: readonly string[]
): Promise<Map<string, ProjectRef | null>> {
  const distinct = [...new Set(folders.filter((dir) => dir.length > 0))];
  const resolved = await Promise.all(
    distinct.map((dir) => projectRegistry.resolve(dir).catch(() => null))
  );
  return new Map(distinct.map((dir, i) => [dir, resolved[i] ?? null]));
}
