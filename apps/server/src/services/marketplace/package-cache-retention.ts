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
 * 3. It is the most recently used entry of a package that is installed, so a
 *    staged update is applied from the tree the check validated. Packages
 *    that are not installed (previewed, or since uninstalled) keep nothing, or
 *    browsing would grow the cache without bound.
 *
 * Everything else goes. The cache then holds at most two entries per
 * installed package, however often anything checks for updates.
 *
 * Who sweeps: {@link PackageCacheRetention}. The cache grows through one
 * door, a fetch landing a new entry, so the owner sweeps right after each one
 * (coalesced), once at startup, and when a person runs `dorkos cache prune`.
 * No timer, and no disk budget: the rule already bounds the cache by what is
 * installed, so a budget could only evict what the rule protects.
 *
 * @module services/marketplace/package-cache-retention
 */
import { isRealCommitSha } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { readInstallMetadata } from './installed-metadata.js';
import { scanInstallationsAcrossScopes, type AgentScopeRef } from './installed-scanner.js';
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
 * The tree every installation in view records: the global install roots plus
 * each registered agent's project. Installs with no real commit (local and
 * `file://` ones, or a sidecar that could not resolve one) record nothing.
 *
 * An agent project the server cannot read is skipped by the scan, so its
 * installs protect nothing; their entries can be fetched again by commit.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param agents - Registered agents whose projects to scan.
 */
export async function listRecordedTrees(
  dorkHome: string,
  agents: AgentScopeRef[]
): Promise<RecordedTree[]> {
  const installations = await scanInstallationsAcrossScopes(dorkHome, agents);
  const trees: RecordedTree[] = [];
  for (const installation of installations) {
    const metadata = await readInstallMetadata(installation.installPath);
    if (!metadata || !isRealCommitSha(metadata.commitSha)) continue;
    trees.push({
      name: metadata.name,
      commitSha: metadata.commitSha,
      ...(metadata.sourceKey !== undefined && { subpath: metadata.sourceKey.subpath }),
    });
  }
  return trees;
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

  // Rule 3: the most recently used entry of each installed package.
  const newest = new Map<string, CachedPackage>();
  for (const entry of entries) {
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
  /** Registered agents whose project installs also record trees. */
  listAgentScopes: () => AgentScopeRef[];
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
    const recorded = await listRecordedTrees(this.deps.dorkHome, this.deps.listAgentScopes());
    const { removed, freedBytes, failed } = await this.deps.cache.removeUnused((entries) =>
      keepRule(entries, recorded)
    );
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
