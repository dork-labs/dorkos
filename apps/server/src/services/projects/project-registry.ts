/**
 * Every project the server knows, each with one short, stable name (spec
 * `flow-multiproject` §6.1, N4).
 *
 * A project is a git main checkout ({@link resolveProjectRoot}). The registry
 * remembers the ones it has seen: every session folder the server resolves,
 * every agent's folder, every workspace source and every project a package was
 * installed into. Extensions may add one with `ctx.projects.report`, and such a
 * root is second-class: it is stored as `reported`, it never widens where core
 * looks for extension code, and seeing it later as a session, agent, workspace
 * or install folder upgrades it to `seen`.
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
 * write through to `known_projects`. Resolving a folder costs one `git` the
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
import type { KnownProject, KnownProjectsPort } from './known-projects-store.js';
import { parseOriginRepo } from './origin-repo.js';
import { peekProjectRoot, resolveProjectRoot } from './resolve-project-root.js';

/** How often a project's `lastSeenAt` is written, at most. */
const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60_000;

/** How often {@link ProjectRegistry.list} re-reads the seed sources, at most. */
const SOURCES_REFRESH_INTERVAL_MS = 60_000;

/** How long an extension's scoped list is reused before its folders are checked again. */
const EXTENSION_SCOPE_TTL_MS = 60_000;

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
  /** Extension ids that reported each root in this process, beyond `reportedBy`. */
  private readonly reporters = new Map<string, Set<string>>();
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
   * Called once at boot, before any seed.
   *
   * @param store - Where projects are kept.
   */
  attachStore(store: KnownProjectsPort): void {
    // Anything recorded before the store existed (a boot-time read that ran
    // first) is kept, but the stored rows win: their names came first.
    const early = [...this.byRoot.values()];
    this.store = store;
    this.byRoot.clear();
    this.names.clear();
    for (const project of store.all()) {
      this.byRoot.set(project.root, project);
      this.names.add(project.name);
    }
    for (const project of early) {
      if (this.byRoot.has(project.root)) continue;
      const kept: KnownProject = {
        ...project,
        name: assignProjectName(project.root, (name) => this.names.has(name)),
      };
      this.byRoot.set(kept.root, kept);
      this.names.add(kept.name);
      this.persist(() => store.insert(kept), `record ${kept.root}`);
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
   * The project a folder belongs to, remembered as seen.
   *
   * @param cwd - Any absolute folder.
   * @returns The project, or null when the folder is in no repository.
   */
  async resolve(cwd: string): Promise<ProjectRef | null> {
    const root = await this.deps.resolveRoot(cwd);
    if (root === null) return null;
    return toRef(await this.remember(root, { source: 'seen' }));
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
   * An extension's hint about a project core may not have seen. The path must
   * pass the directory boundary and be inside a git repository; otherwise
   * nothing is recorded.
   *
   * @param dir - Any folder inside the project.
   * @param extensionId - The extension reporting it.
   * @returns The project, or null.
   */
  async report(dir: string, extensionId: string): Promise<ProjectRef | null> {
    let checked: string;
    try {
      checked = await this.deps.checkBoundary(dir);
    } catch {
      return null;
    }
    const root = await this.deps.resolveRoot(checked);
    if (root === null) return null;
    let reporters = this.reporters.get(root);
    if (!reporters) this.reporters.set(root, (reporters = new Set()));
    const firstReport = !reporters.has(extensionId);
    reporters.add(extensionId);
    const project = await this.remember(root, { source: 'reported', reportedBy: extensionId });
    if (firstReport) this.invalidateScopes();
    return toRef(project);
  }

  /**
   * The project a folder an extension named belongs to (`ctx.projects.resolve`).
   *
   * Unlike {@link resolve}, the folder must pass the directory boundary, and a
   * root core had not seen is recorded as `reported` (with no reporter), so an
   * extension resolving a folder never makes it `seen` and never widens where
   * core looks for extension code. Unlike {@link report}, it does not add the
   * project to the extension's own {@link listForExtension}.
   *
   * @param dir - Any folder.
   * @returns The project, or null outside the boundary or outside a repository.
   */
  async resolveForExtension(dir: string): Promise<ProjectRef | null> {
    let checked: string;
    try {
      checked = await this.deps.checkBoundary(dir);
    } catch {
      return null;
    }
    const root = await this.deps.resolveRoot(checked);
    if (root === null) return null;
    const known = this.byRoot.get(root);
    if (known) return toRef(known);
    return toRef(await this.remember(root, { source: 'reported', reportedBy: null }));
  }

  /**
   * Every known project whose folder exists, by name. Folders that are gone
   * are hidden and kept (a drive may be unplugged).
   */
  async list(): Promise<ProjectInfo[]> {
    await this.refreshSources();
    const present = await this.present();
    return present.map(toInfo).sort(byName);
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
   * Whether a root is known only because an extension reported it. Such a
   * root must never widen where core looks for extension code (§6.1).
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

  private async scopeFor(extensionId: string, present: KnownProject[]): Promise<Set<string>> {
    const allowed = new Set<string>();
    await Promise.all(
      present.map(async (project) => {
        if (
          project.reportedBy === extensionId ||
          this.reporters.get(project.root)?.has(extensionId) ||
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
        await Promise.all(
          folders.map((dir) =>
            this.resolve(dir).catch((err) => this.warn(`could not resolve ${dir}`, err))
          )
        );
      } catch (err) {
        this.warn('could not read the folders to seed projects from', err);
      } finally {
        this.sourcesRead = undefined;
      }
    })();
    return this.sourcesRead;
  }

  private remember(
    root: string,
    how: { source: 'seen' } | { source: 'reported'; reportedBy: string | null }
  ): Promise<KnownProject> {
    const existing = this.byRoot.get(root);
    if (existing) return Promise.resolve(this.touch(existing, how.source));
    const inFlight = this.recording.get(root);
    if (inFlight) return inFlight.then((project) => this.touch(project, how.source));
    const recorded = this.record(root, how).finally(() => this.recording.delete(root));
    this.recording.set(root, recorded);
    return recorded;
  }

  private async record(
    root: string,
    how: { source: 'seen' } | { source: 'reported'; reportedBy: string | null }
  ): Promise<KnownProject> {
    const originRepo = await this.deps.readOriginRepo(root);
    const at = new Date(this.deps.now()).toISOString();
    const project: KnownProject = {
      root,
      name: assignProjectName(root, (name) => this.names.has(name)),
      originRepo,
      source: how.source,
      reportedBy: how.source === 'reported' ? how.reportedBy : null,
      firstSeenAt: at,
      lastSeenAt: at,
    };
    this.byRoot.set(root, project);
    this.names.add(project.name);
    this.lastWritten.set(root, this.deps.now());
    this.persist(() => this.store?.insert(project), `record ${root}`);
    this.changed();
    return project;
  }

  private touch(project: KnownProject, source: 'seen' | 'reported'): KnownProject {
    const now = this.deps.now();
    const upgrade = source === 'seen' && project.source === 'reported';
    const stale = now - (this.lastWritten.get(project.root) ?? 0) >= LAST_SEEN_WRITE_INTERVAL_MS;
    if (!upgrade && !stale) return project;
    const lastSeenAt = new Date(now).toISOString();
    const next: KnownProject = { ...project, lastSeenAt, ...(upgrade ? { source: 'seen' } : {}) };
    this.byRoot.set(project.root, next);
    this.lastWritten.set(project.root, now);
    this.persist(
      () =>
        this.store?.update(project.root, { lastSeenAt, ...(upgrade ? { source: 'seen' } : {}) }),
      `update ${project.root}`
    );
    if (upgrade) this.changed();
    return next;
  }

  private persist(write: () => void, what: string): void {
    try {
      write();
    } catch (err) {
      // The registry keeps working from memory; it only forgets on restart.
      this.warn(`could not ${what}`, err);
    }
  }

  private invalidateScopes(): void {
    this.scoped.clear();
  }

  private changed(): void {
    this.invalidateScopes();
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
