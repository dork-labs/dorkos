/**
 * Retention for the marketplace package cache: which entries stay, and the
 * one owner that sweeps the rest (DOR-2249).
 *
 * An entry is kept when any of these holds:
 *
 * 1. It was used in the last `IN_USE_GRACE_MS`. {@link MarketplaceCache}
 *    enforces this itself, so a request reading a tree never loses it.
 * 2. An installation records its commit (`install-metadata.json`'s
 *    `commitSha`, and `sourceKey.subpath` when the sidecar has one). Matched by
 *    commit, never by name: a direct git install keys the cache by the name a
 *    person typed, while the sidecar records the manifest's. Rebuilding an
 *    install's file record fetches this commit (DOR-2245), and after a
 *    force-push it may exist nowhere else.
 * 3. It is the most recently used entry of a package that is installed,
 *    among those rule 2 does not already keep, so a staged update is applied
 *    from the tree the check validated. Once that update is applied, the
 *    superseded tree can hold this place until the next update is staged,
 *    which still bounds the cache at two entries per package. Packages
 *    that are not installed (previewed, or since uninstalled) keep nothing, or
 *    browsing would grow the cache without bound.
 *
 * Everything else goes. The cache then holds at most two entries per
 * installed package, however often anything checks for updates.
 *
 * What installs record is read strictly ({@link listRecordedTrees}): the
 * global install roots, every registered agent's project, and every project
 * install the installer recorded (`lib/project-install-index.ts`). A sweep
 * deletes whatever that read does not return, so anything it cannot read
 * stops the sweep instead of shrinking the answer.
 *
 * Who sweeps: {@link PackageCacheRetention}. The cache grows through one
 * door, a fetch landing a new entry, so the owner sweeps right after each one
 * (coalesced), once at startup, and when a person runs `dorkos cache prune`.
 * No timer, and no disk budget: the rule already bounds the cache by what is
 * installed, so a budget could only evict what the rule protects.
 *
 * @module services/marketplace/package-cache-retention
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isRealCommitSha } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { readInstallMetadataStrict } from './installed-metadata.js';
import type { AgentScopeRef } from './installed-scanner.js';
import { installRootsUnder, projectScopeRoot } from './lib/install-roots.js';
import {
  forgetProjectInstalls,
  readProjectInstalls,
  type ProjectInstallRecord,
} from './lib/project-install-index.js';
import {
  subpathDigest,
  type CachedPackage,
  type MarketplaceCache,
  type RemovedEntries,
} from './marketplace-cache.js';

/** The tree one installation records it was installed from. */
export interface RecordedTree {
  /** The package name the sidecar records (the manifest's). */
  name: string;
  /** The full commit id it was fetched at. */
  commitSha: string;
  /**
   * The subfolder it was fetched from (`sourceKey.subpath`; `''` for the whole
   * repository). Absent when the sidecar has no source key (written before
   * DOR-2244), which then protects every entry at the commit.
   */
  subpath?: string;
}

/**
 * The sweep could not read everything installs record, so it removed
 * nothing. `where` names the folder or file, for the server log.
 */
export class UnreadableInstallsError extends Error {
  /**
   * Build the error for one unreadable place.
   *
   * @param where - The folder or file that could not be read.
   * @param cause - Why, when there is an underlying error.
   */
  constructor(
    readonly where: string,
    cause?: unknown
  ) {
    super(
      `Couldn't read ${where}${cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`}`
    );
    this.name = 'UnreadableInstallsError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** What {@link listRecordedTrees} found. */
export interface RecordedInstalls {
  /** The tree every readable or recorded installation records. */
  trees: RecordedTree[];
  /** Project-install records whose install is verifiably gone (uninstalled). */
  goneProjectInstalls: string[];
}

/**
 * Everything installations record, read strictly: the global install roots,
 * every registered agent's project, and every project install the installer
 * recorded (`lib/project-install-index.ts`, which also covers folders that are
 * not, or are no longer, registered agents).
 *
 * The sweep deletes whatever this does not return, so doubt must throw, never
 * shrink the answer. It throws {@link UnreadableInstallsError} when:
 * - the agent registry is unavailable (`agents` is `undefined`);
 * - a registered agent's project folder is missing (an unplugged drive looks
 *   exactly like this);
 * - an install root or a sidecar exists but cannot be read, or a sidecar or
 *   the project-install index cannot be parsed.
 *
 * A folder that does not exist is simply empty. A recorded project install
 * that cannot be reached is protected by its record; one whose project folder
 * exists but whose install folder does not was uninstalled, and is returned
 * in `goneProjectInstalls` so its record can be dropped.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param agents - Registered agents, or `undefined` when the registry is unavailable.
 */
export async function listRecordedTrees(
  dorkHome: string,
  agents: AgentScopeRef[] | undefined
): Promise<RecordedInstalls> {
  if (agents === undefined) throw new UnreadableInstallsError('the agent registry');
  const trees: RecordedTree[] = [];
  const goneProjectInstalls: string[] = [];

  await scanScopeStrict(dorkHome, trees);

  for (const agent of agents) {
    if (!(await isExisting(agent.projectPath))) {
      throw new UnreadableInstallsError(agent.projectPath, 'the folder is missing');
    }
    await scanScopeStrict(projectScopeRoot(agent.projectPath), trees);
  }

  let records: ProjectInstallRecord[];
  try {
    records = await readProjectInstalls(dorkHome);
  } catch (err) {
    throw new UnreadableInstallsError('the project install record', err);
  }
  for (const record of records) {
    const recordedTree: RecordedTree | null = isRealCommitSha(record.commitSha)
      ? {
          name: record.name,
          commitSha: record.commitSha,
          ...(record.subpath !== undefined && { subpath: record.subpath }),
        }
      : null;
    const installPresent = await existence(record.installRoot);
    if (installPresent === 'present') {
      // The sidecar is the fresher truth; the record stands in if it is absent.
      const fromSidecar = await readTreeStrict(record.installRoot);
      const tree = fromSidecar === undefined ? recordedTree : fromSidecar;
      if (tree) trees.push(tree);
    } else if (
      installPresent === 'missing' &&
      (await existence(record.projectPath)) === 'present'
    ) {
      goneProjectInstalls.push(record.installRoot);
    } else if (recordedTree) {
      // Unreachable (a drive not plugged in, a folder we may not read): keep
      // protecting what it recorded.
      trees.push(recordedTree);
    }
  }

  return { trees, goneProjectInstalls };
}

/**
 * Add the tree of every install under one scope root, strictly.
 *
 * @internal
 */
async function scanScopeStrict(scopeRoot: string, trees: RecordedTree[]): Promise<void> {
  for (const { dir } of installRootsUnder(scopeRoot)) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new UnreadableInstallsError(dir, err);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const tree = await readTreeStrict(join(dir, entry.name));
      if (tree) trees.push(tree);
    }
  }
}

/**
 * The tree one install's sidecar records: `undefined` when there is no
 * sidecar, `null` when it records no real commit.
 *
 * @throws {UnreadableInstallsError} When the sidecar exists but cannot be
 *   read or parsed.
 * @internal
 */
async function readTreeStrict(installRoot: string): Promise<RecordedTree | null | undefined> {
  let metadata;
  try {
    metadata = await readInstallMetadataStrict(installRoot);
  } catch (err) {
    throw new UnreadableInstallsError(installRoot, err);
  }
  if (metadata === null) return undefined;
  if (!isRealCommitSha(metadata.commitSha)) return null;
  return {
    name: metadata.name,
    commitSha: metadata.commitSha,
    ...(metadata.sourceKey !== undefined && { subpath: metadata.sourceKey.subpath }),
  };
}

/**
 * Whether `target` exists: `'missing'` only on ENOENT, `'unknown'` on any
 * other failure (which proves nothing either way).
 *
 * @internal
 */
async function existence(target: string): Promise<'present' | 'missing' | 'unknown'> {
  try {
    await stat(target);
    return 'present';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

/**
 * True only when `target` verifiably exists.
 *
 * @internal
 */
async function isExisting(target: string): Promise<boolean> {
  const found = await existence(target);
  if (found === 'unknown') throw new UnreadableInstallsError(target);
  return found === 'present';
}

/**
 * Rules 2 and 3 of the module doc: the entries installations need. Pure, so
 * the rule is testable without a disk.
 *
 * @param entries - Every entry in the cache.
 * @param recorded - What every installation records.
 * @returns The paths of the entries to keep.
 */
export function keepRule(
  entries: readonly CachedPackage[],
  recorded: readonly RecordedTree[]
): ReadonlySet<string> {
  const kept = new Set<string>();
  const sameTree = (tree: RecordedTree, entry: CachedPackage): boolean =>
    tree.subpath === undefined || subpathDigest(tree.subpath) === entry.subpathDigest;

  // Rule 2: the recorded commit, whatever name the cache stored it under.
  for (const entry of entries) {
    if (recorded.some((tree) => tree.commitSha === entry.commitSha && sameTree(tree, entry))) {
      kept.add(entry.path);
    }
  }

  // Rule 3: the most recently used entry of each installed package, among the
  // entries rule 2 does not already keep. Otherwise reading the installed
  // commit again (DOR-2245 rebuilds a file record from it) would make it the
  // newest and cost a staged update its place.
  const newest = new Map<string, CachedPackage>();
  for (const entry of entries) {
    if (kept.has(entry.path)) continue;
    if (!recorded.some((tree) => tree.name === entry.packageName && sameTree(tree, entry))) {
      continue;
    }
    const group = `${entry.packageName}\0${entry.subpathDigest}`;
    const current = newest.get(group);
    if (!current || entry.lastUsedAt.getTime() > current.lastUsedAt.getTime()) {
      newest.set(group, entry);
    }
  }
  for (const entry of newest.values()) kept.add(entry.path);

  return kept;
}

/** Collaborators of {@link PackageCacheRetention}. */
export interface PackageCacheRetentionDeps {
  /** The cache to keep tidy. */
  cache: MarketplaceCache;
  /** Resolved DorkOS data directory (global installs live under it). */
  dorkHome: string;
  /**
   * Registered agents whose project installs also record trees, or
   * `undefined` when the registry is unavailable (the sweep then removes
   * nothing).
   */
  listAgentScopes: () => AgentScopeRef[] | undefined;
  /** Where background sweeps report. */
  logger: Logger;
}

/** What one sweep removed. */
export type SweepResult = Pick<RemovedEntries, 'removed' | 'freedBytes'>;

/**
 * The package cache's retention owner. Sweeps after every new entry, once at
 * {@link start}, and on demand ({@link sweep}), applying {@link keepRule}.
 *
 * Sweeps are coalesced: one runs at a time, and every request made while it
 * runs shares the single sweep queued behind it.
 */
export class PackageCacheRetention {
  /** The sweep running now, if any. */
  private running: Promise<SweepResult> | null = null;

  /** The sweep queued behind {@link running}, shared by every request since. */
  private queued: Promise<SweepResult> | null = null;

  /**
   * Create the owner. Nothing runs until {@link start} or {@link sweep}.
   *
   * @param deps - Cache, data directory, agent scopes and logger.
   */
  constructor(private readonly deps: PackageCacheRetentionDeps) {}

  /**
   * Sweep after every entry the cache lands from now on, and once now. Both
   * run in the background: their removals are logged at info and their
   * failures at warn, and they never throw.
   */
  start(): void {
    this.deps.cache.onEntryWritten(() => this.sweepInBackground());
    this.sweepInBackground();
  }

  /**
   * Remove every entry the rule does not keep and nobody used recently.
   *
   * @returns What was removed and the bytes freed.
   * @throws When the installations cannot be listed; nothing is removed then,
   *   because a failed read must not look like "nothing is installed".
   */
  sweep(): Promise<SweepResult> {
    if (this.queued) return this.queued;
    if (!this.running) return this.begin();
    const after = this.running.catch(() => undefined);
    this.queued = after.then(() => {
      this.queued = null;
      return this.begin();
    });
    return this.queued;
  }

  /**
   * Start a sweep now and track it as {@link running}.
   *
   * @internal
   */
  private begin(): Promise<SweepResult> {
    const run = this.runSweep();
    this.running = run;
    const clear = (): void => {
      if (this.running === run) this.running = null;
    };
    run.then(clear, clear);
    return run;
  }

  /**
   * One sweep: read what installations record, then let the cache remove
   * the rest.
   *
   * @internal
   */
  private async runSweep(): Promise<SweepResult> {
    const { trees, goneProjectInstalls } = await listRecordedTrees(
      this.deps.dorkHome,
      this.deps.listAgentScopes()
    );
    const { removed, freedBytes, failed } = await this.deps.cache.removeUnused((entries) =>
      keepRule(entries, trees)
    );
    await forgetProjectInstalls(this.deps.dorkHome, goneProjectInstalls);
    for (const { entry, error } of failed) {
      this.deps.logger.warn('[Marketplace] could not remove an unused cached package', {
        packageName: entry.packageName,
        commitSha: entry.commitSha,
        error,
      });
    }
    return { removed, freedBytes };
  }

  /**
   * {@link sweep}, with its outcome logged rather than returned.
   *
   * @internal
   */
  private sweepInBackground(): void {
    this.sweep().then(
      ({ removed, freedBytes }) => {
        if (removed.length === 0) return;
        this.deps.logger.info(
          `[Marketplace] Removed ${removed.length} unused package ${removed.length === 1 ? 'tree' : 'trees'} from the cache`,
          { freedBytes }
        );
      },
      (err: unknown) => {
        this.deps.logger.warn('[Marketplace] could not tidy the package cache', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    );
  }
}
