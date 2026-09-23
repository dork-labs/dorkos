/**
 * Marketplace package update flow.
 *
 * Advisory by default: enumerates installed packages, works out what
 * installing each one right now would give, and returns the comparison
 * without touching disk. When `apply: true` is set, the flow delegates
 * reinstallation of every package with an update to an injected
 * {@link InstallerLike}, which runs the uninstall-without-purge → install
 * pattern that preserves `.dork/data/` and `.dork/secrets.json` (ADR-0233).
 *
 * "What installing now would give" is answered by the installer's own
 * resolve → stage → validate pipeline (`MarketplaceInstaller.resolveLatest`),
 * and a version is read by Claude Code's chain on both sides: the version the
 * package declares, else its marketplace entry's, else the commit
 * (`resolvePackageVersion`, ADR 260923-122615). Every check ends in one of
 * three statuses — `current`, `update-available` or `unknown` — and nothing is
 * dropped: a package that cannot be checked says why, and is never reported
 * as current.
 *
 * The installer is injected through {@link InstallerLike} to break the
 * circular dependency between this flow and the full installer orchestrator.
 *
 * @module services/marketplace/flows/update
 */
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { gt as semverGt, valid as semverValid } from 'semver';
import {
  isRealCommitSha,
  resolvePackageVersion,
  type MarketplaceJson,
  type MarketplaceJsonEntry,
  type ResolvedPackageVersion,
  type VersionSource,
} from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import {
  installKey,
  installRootsUnder,
  projectScopeRoot,
  updateNameOf,
} from '../lib/install-roots.js';
import type {
  InstallRequest,
  InstallResult,
  LatestResolution,
  MarketplaceSource,
  ResolveLatestOptions,
} from '../types.js';
import { readInstallMetadata, type InstallMetadata } from '../installed-metadata.js';
import { readInstalledIdentity } from '../installed-scanner.js';

/**
 * How long a commit lookup or a marketplace index fetch is shared between
 * checks. The CLI sends one request per package, so a memo scoped to one
 * `run()` would never span packages; one scoped to the instance with this TTL
 * is "shared within one CLI run or UI burst". Without a refresh, a push made
 * within the last minute can still read as current.
 */
export const UPDATE_MEMO_TTL_MS = 60_000;

/** A ref that is already a full commit SHA — `ls-remote` cannot look one up. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** The note on a check whose installed side names no version at all. */
const INSTALLED_UNKNOWN_NOTE = 'reinstall this package to enable update checks';

/** The note on a direct install checked against its default branch. */
const DEFAULT_BRANCH_NOTE =
  'checked against the default branch: this package was installed before DorkOS recorded which branch it came from';

/**
 * Structural interface for the forward-declared `MarketplaceInstaller`.
 * Declared here so the update flow can be wired against either the real
 * installer or a test double without a circular import.
 */
export interface InstallerLike {
  /**
   * Update an installed package by uninstalling (without purging
   * `.dork/data/` or `.dork/secrets.json`) and reinstalling fresh.
   * Preserves user secrets and persisted state across version bumps.
   */
  update(req: InstallRequest): Promise<InstallResult>;
  /**
   * Work out what installing a package now would give, without installing.
   * Never throws: a failure is an `unresolved` result with a reason.
   */
  resolveLatest(req: InstallRequest, opts: ResolveLatestOptions): Promise<LatestResolution>;
}

/**
 * Structural interface for {@link import('../marketplace-source-manager.js').MarketplaceSourceManager}.
 * Declared locally so tests can mock with `vi.fn()` without constructing
 * the concrete class.
 */
export interface UpdateSourceManagerLike {
  list(): Promise<MarketplaceSource[]>;
  get(name: string): Promise<MarketplaceSource | null>;
}

/**
 * Structural interface for the parts of
 * {@link import('../package-fetcher.js').PackageFetcher} the update check uses.
 */
export interface UpdateFetcherLike {
  fetchMarketplaceJson(source: MarketplaceSource): Promise<MarketplaceJson>;
  /** `git ls-remote` for one ref; a `tmp-<ms>` placeholder when it fails. */
  lookupCommitSha(cloneUrl: string, ref: string): Promise<string>;
}

/** The outcome of checking one package. */
export type UpdateStatus = 'current' | 'update-available' | 'unknown';

/** A single comparison result for one installed package. */
export interface UpdateCheckResult {
  packageName: string;
  /** The installed version, or the full commit SHA when its source is `'commit'`. */
  installedVersion: string;
  /** What installing now would give; `''` when `status === 'unknown'`. */
  latestVersion: string;
  /** Always `status === 'update-available'`. */
  hasUpdate: boolean;
  /** The marketplace the package was checked against; `''` for direct installs and unknowns. */
  marketplace: string;
  status: UpdateStatus;
  /** Which step of Claude Code's chain the installed version came from. */
  installedVersionSource?: VersionSource;
  /** Which step of Claude Code's chain the latest version came from. */
  latestVersionSource?: VersionSource;
  /** Why a check is `unknown`, or a caveat on a known answer (a rollback, a default branch). */
  note?: string;
}

/** A request to check for (and optionally apply) updates. */
export interface UpdateRequest {
  /** Specific package name; if omitted, check every installed package. */
  name?: string;
  /** Apply the update (default: advisory only). */
  apply?: boolean;
  /**
   * Project path for project-local installs. Adds that project's own install
   * roots to the scan (taking precedence over a global package of the same
   * name) and scopes any applied reinstall to the project.
   */
  projectPath?: string;
}

/** The composite result of an update check. */
export interface UpdateResult {
  checks: UpdateCheckResult[];
  /** Populated only when `apply: true`; one entry per successful reinstall. */
  applied: InstallResult[];
}

/** Constructor dependencies for {@link UpdateFlow}. */
export interface UpdateFlowDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Installer orchestrator: resolves the latest version, and reinstalls on apply. */
  installer: InstallerLike;
  /** Source manager used to resolve marketplace names to sources. */
  sourceManager: UpdateSourceManagerLike;
  /** Package fetcher used for marketplace.json documents and commit lookups. */
  fetcher: UpdateFetcherLike;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Clock for the memo TTL; defaults to `Date.now`. */
  now?: () => number;
}

/** A discovered installed package on disk, with its install sidecar. */
interface InstalledPackage {
  name: string;
  /** From `readDeclaredVersion`; undefined when the package states none. */
  declaredVersion?: string;
  metadata: InstallMetadata | null;
}

/** One check, plus the request that would apply it. */
interface PlannedCheck {
  check: UpdateCheckResult;
  /** The reinstall request, present only when the check can be applied. */
  request?: InstallRequest;
}

/** A memoized in-flight or settled promise, and when it stops being shared. */
interface MemoEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

/**
 * Where an installed package would be reinstalled from: the marketplace that
 * lists it, its own recorded source (a direct install), or nowhere.
 */
type UpdateTarget =
  | { kind: 'marketplace'; marketplaceName: string }
  | { kind: 'direct'; source: string; note?: string }
  | { kind: 'none'; note: string };

/**
 * Thrown by the route when a named package is installed in no scope at all.
 * The flow itself cannot tell "not in this scope" from "installed nowhere", so
 * it returns an `unknown` result for a name missing from its scope and leaves
 * the 404 to the route, which can see every scope.
 */
export class PackageNotInstalledForUpdateError extends Error {
  /**
   * Build a `PackageNotInstalledForUpdateError` for the supplied package name.
   *
   * @param name - The package name that could not be located on disk.
   */
  constructor(public readonly packageName: string) {
    super(`Package not installed: ${packageName}`);
    this.name = 'PackageNotInstalledForUpdateError';
  }
}

/**
 * Advisory-by-default update orchestrator for marketplace packages.
 *
 * Run with no `name` to get a comparison for every installed package; pass
 * `name` to narrow to one. Pass `apply: true` to reinstall every package whose
 * check is `update-available`. One instance serves the whole server, and it
 * holds the commit-lookup and index memos (see {@link UPDATE_MEMO_TTL_MS}).
 */
export class UpdateFlow {
  private readonly commitMemo = new Map<string, MemoEntry<string>>();
  private readonly indexMemo = new Map<string, MemoEntry<MarketplaceJson>>();

  constructor(private readonly deps: UpdateFlowDeps) {}

  /**
   * Execute the update flow.
   *
   * @param req - Update request — name filter, apply flag, project path.
   * @returns One check per installed package in scope (or one `unknown`
   *   "not installed in this scope" check for a named package missing from
   *   it), and any applied reinstall results.
   */
  async run(req: UpdateRequest): Promise<UpdateResult> {
    const installed = await this.listInstalled(req.projectPath);

    let planned: PlannedCheck[];
    if (req.name) {
      const match = installed.find((pkg) => pkg.name === req.name);
      planned = match ? [await this.checkOne(match)] : [{ check: notInScope(req.name) }];
    } else {
      planned = [];
      for (const pkg of installed) planned.push(await this.checkOne(pkg));
    }

    const applied: InstallResult[] = [];
    if (req.apply) {
      try {
        for (const { check, request } of planned) {
          if (check.status !== 'update-available' || !request) continue;
          applied.push(
            await this.deps.installer.update({ ...request, projectPath: req.projectPath })
          );
        }
      } finally {
        // What was just installed changes what the next check should see.
        this.clearMemos();
      }
    }

    return { checks: planned.map((p) => p.check), applied };
  }

  /**
   * Forget every memoized commit lookup and index fetch, so the next check
   * asks again. Called after every apply and by the marketplace refresh route,
   * which is how "I just pushed; check again" gets a fresh answer.
   */
  clearMemos(): void {
    this.commitMemo.clear();
    this.indexMemo.clear();
  }

  /**
   * Walk every install root in scope ({@link installRootsUnder}:
   * `plugins/`, `agents/`, `shapes/`), reading each install's identity through
   * the installed scanner's {@link readInstalledIdentity} — the same reader the
   * installed list uses, never gated on validity, so a Claude-Code-only
   * install and one whose version files disagree are both checked — and its
   * `.dork/install-metadata.json` sidecar. Unreadable installs are skipped so
   * one malformed install never blocks the check.
   *
   * Those roots hang off one or two scope roots. `dorkHome` is always walked.
   * When the caller supplied a `projectPath`, that project's own `.dork/` is
   * walked FIRST — a project install is where `PluginInstallFlow` and
   * `AgentInstallFlow` land a scoped install, and it shadows a global package
   * of the same name for that project. That precedence matches the installed
   * scanner's merged view and the uninstall flow's probe (DOR-994).
   *
   * Results are deduplicated by {@link installKey} (install-root kind plus
   * package name), first root wins — so a project's `plugins/foo` shadows the
   * global `plugins/foo`, while a global `agents/foo` survives as its own
   * entry, and each resolves its own marketplace.
   *
   * @param projectPath - Project directory to also scan, when the request
   *   carried one.
   * @internal
   */
  private async listInstalled(projectPath?: string): Promise<InstalledPackage[]> {
    const byRootAndName = new Map<string, InstalledPackage>();
    // A scope root is the directory the install-root subdirectories hang off:
    // `dorkHome` IS the global `.dork`, and a project's is `<projectPath>/.dork`
    // (same derivation as `ConflictDetector.detect`). Shapes are global-only, so
    // a project's `shapes/` simply never exists and its walk yields nothing.
    const scopeRoots = projectPath
      ? [projectScopeRoot(projectPath), this.deps.dorkHome]
      : [this.deps.dorkHome];
    const roots = scopeRoots.flatMap(installRootsUnder);

    for (const root of roots) {
      const entries = await readDirSafe(root.dir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip crash-left install backups (`<name>.dorkos-bak-<ts>-<uuid>`,
        // DOR-175) — a backup carries the previous installation's valid
        // manifest under the same name, so without this guard update-all
        // would target the backup path as a phantom duplicate package.
        if (entry.name.includes(MARKETPLACE_BACKUP_DIR_MARKER)) continue;
        const installPath = path.join(root.dir, entry.name);
        const identity = await readInstalledIdentity(installPath);
        if (!identity) continue;
        const name = updateNameOf(identity.name, installPath);
        const key = installKey(root.kind, name);
        if (byRootAndName.has(key)) continue;
        byRootAndName.set(key, {
          name,
          declaredVersion: identity.declaredVersion,
          metadata: await readInstallMetadata(installPath),
        });
      }
    }

    return [...byRootAndName.values()];
  }

  /**
   * Check one installed package: find where it would be reinstalled from, ask
   * the installer what that would give, and compare by Claude Code's chain.
   *
   * @internal
   */
  private async checkOne(pkg: InstalledPackage): Promise<PlannedCheck> {
    const recorded = pkg.metadata;
    const installedCommit = isRealCommitSha(recorded?.commitSha) ? recorded.commitSha : undefined;
    const installed = resolvePackageVersion({
      declaredVersion: pkg.declaredVersion,
      entryVersion: recorded?.entryVersion,
      commitSha: installedCommit,
    });

    const target = await this.findTarget(pkg);
    if (target.kind === 'none') {
      this.deps.logger.warn('update-flow: no marketplace entry found for package', {
        packageName: pkg.name,
        note: target.note,
      });
      return { check: unknownCheck(pkg.name, installed, target.note) };
    }

    const request: InstallRequest =
      target.kind === 'marketplace'
        ? { name: pkg.name, marketplace: target.marketplaceName }
        : { name: pkg.name, source: target.source };
    const latest = await this.deps.installer.resolveLatest(request, {
      installed: {
        commitSha: installedCommit,
        entryVersion: recorded?.entryVersion,
        sourceKey: recorded?.sourceKey,
      },
      commitLookup: (cloneUrl, ref) => this.lookupCommit(cloneUrl, ref),
    });

    const marketplace = target.kind === 'marketplace' ? target.marketplaceName : '';
    const check = compareVersions(pkg.name, marketplace, installed, latest);
    if (target.kind === 'direct' && target.note) {
      check.note = joinNotes(target.note, check.note);
    }
    return { check, request };
  }

  /**
   * Decide where a package would be reinstalled from.
   *
   * A direct install (`name@url`, `github:`; no `installedFrom`, a recorded
   * `sourceRepo`) is checked against its own source, rebuilt from its recorded
   * `sourceKey` when there is one. Everything else searches the marketplaces:
   * `installedFrom` first if it is enabled, then every enabled source. The
   * MATCHED source is what the installer receives, never `installedFrom`
   * blindly, so a bare-name lookup cannot hit `AmbiguousPackageError` when
   * two sources list the package, and a disabled source is never used.
   *
   * @internal
   */
  private async findTarget(pkg: InstalledPackage): Promise<UpdateTarget> {
    const recorded = pkg.metadata;
    if (!recorded?.installedFrom && recorded?.sourceRepo) {
      // No "apply reinstalls from the default branch" note: both direct forms
      // (`name@url`, `github:`) resolve to a ref-less url source, so a recorded
      // key is always `ref: 'main'`, `subpath: ''` and apply matches it.
      return recorded.sourceKey
        ? { kind: 'direct', source: recorded.sourceKey.cloneUrl }
        : { kind: 'direct', source: recorded.sourceRepo, note: DEFAULT_BRANCH_NOTE };
    }

    const unreachable: string[] = [];
    const candidates: MarketplaceSource[] = [];
    if (recorded?.installedFrom) {
      const source = await this.deps.sourceManager.get(recorded.installedFrom);
      if (source?.enabled) candidates.push(source);
    }
    for (const source of await this.deps.sourceManager.list()) {
      if (source.enabled && !candidates.some((c) => c.name === source.name)) {
        candidates.push(source);
      }
    }

    for (const source of candidates) {
      const entry = await this.findEntry(source, pkg.name, unreachable);
      if (entry) return { kind: 'marketplace', marketplaceName: source.name };
    }
    return {
      kind: 'none',
      note:
        unreachable.length > 0
          ? `couldn't read the marketplace list from ${unreachable.join(', ')}`
          : 'no enabled marketplace lists this package',
    };
  }

  /**
   * Find a package's entry in one marketplace's index (memoized per source).
   * A fetch failure records the source as unreachable and reads as "not
   * listed here", so one unreachable marketplace never blocks the others —
   * but the check still says it could not read it.
   *
   * @internal
   */
  private async findEntry(
    source: MarketplaceSource,
    packageName: string,
    unreachable: string[]
  ): Promise<MarketplaceJsonEntry | undefined> {
    try {
      const json = await this.memoized(this.indexMemo, source.name, () =>
        this.deps.fetcher.fetchMarketplaceJson(source)
      );
      return json.plugins.find((entry) => entry.name === packageName);
    } catch (err) {
      this.deps.logger.warn('update-flow: failed to fetch marketplace.json', {
        marketplaceName: source.name,
        error: err instanceof Error ? err.message : String(err),
      });
      unreachable.push(source.name);
      return undefined;
    }
  }

  /**
   * The memoized commit lookup handed to the installer. A ref that is already
   * a full SHA is its own commit and is returned without `ls-remote`, which
   * matches ref names only and would report a pinned package unreachable. A
   * placeholder answer is returned but never kept, so a retry looks again.
   *
   * @internal
   */
  private lookupCommit(cloneUrl: string, ref: string): Promise<string> {
    if (FULL_SHA_RE.test(ref)) return Promise.resolve(ref);
    return this.memoized(
      this.commitMemo,
      `${cloneUrl}\n${ref}`,
      () => this.deps.fetcher.lookupCommitSha(cloneUrl, ref),
      isRealCommitSha
    );
  }

  /**
   * Share one promise per key for {@link UPDATE_MEMO_TTL_MS}. The in-flight
   * promise is stored, so concurrent checks (the CLI and the app together)
   * share one request. A rejection, or a value `keep` refuses, is dropped as
   * soon as it settles, so a failure is never served from the memo.
   *
   * @internal
   */
  private memoized<T>(
    memo: Map<string, MemoEntry<T>>,
    key: string,
    load: () => Promise<T>,
    keep: (value: T) => boolean = () => true
  ): Promise<T> {
    const now = (this.deps.now ?? Date.now)();
    const hit = memo.get(key);
    if (hit && hit.expiresAt > now) return hit.promise;

    const promise = load();
    memo.set(key, { promise, expiresAt: now + UPDATE_MEMO_TTL_MS });
    const forget = () => {
      if (memo.get(key)?.promise === promise) memo.delete(key);
    };
    promise.then((value) => {
      if (!keep(value)) forget();
    }, forget);
    return promise;
  }
}

/**
 * Compare an installed package with what installing it now would give, by
 * Claude Code's chain, in order:
 *
 * 1. `unresolved` → unknown, with the reason.
 * 2. The installed side names no version, entry version or real commit →
 *    unknown (file:// marketplaces, pre-DOR-147 sidecars, placeholder SHAs).
 * 3. `unchanged` → current.
 * 4. The latest side names nothing → unknown.
 * 5. Both are versions (`package` or `index`) and both valid semver → an
 *    update only when the latest is strictly newer; a lower one is current
 *    with a rollback note, never offered as an "update".
 * 6. Both are versions but one is not semver → an update when they differ.
 * 7. Either is a commit → an update when they differ, as Claude Code does for
 *    a package that declares no version.
 *
 * @internal
 */
function compareVersions(
  packageName: string,
  marketplace: string,
  installed: ResolvedPackageVersion | undefined,
  latest: LatestResolution
): UpdateCheckResult {
  if (latest.kind === 'unresolved') return unknownCheck(packageName, installed, latest.reason);
  // `unchanged` needs a real recorded commit, so its installed side is always
  // known; checking this first only keeps the types honest.
  if (!installed) return unknownCheck(packageName, installed, INSTALLED_UNKNOWN_NOTE);
  if (latest.kind === 'unchanged') {
    return knownCheck(packageName, marketplace, installed, installed, 'current');
  }

  const latestVersion = resolvePackageVersion(latest);
  if (!latestVersion) {
    return unknownCheck(packageName, installed, "couldn't tell which version the marketplace has");
  }

  const bothVersions = installed.source !== 'commit' && latestVersion.source !== 'commit';
  if (bothVersions && semverValid(installed.version) && semverValid(latestVersion.version)) {
    if (semverGt(latestVersion.version, installed.version)) {
      return knownCheck(packageName, marketplace, installed, latestVersion, 'update-available');
    }
    const check = knownCheck(packageName, marketplace, installed, latestVersion, 'current');
    if (semverGt(installed.version, latestVersion.version)) {
      check.note =
        `rollback: the marketplace has ${latestVersion.version}, older than the installed ` +
        `${installed.version}; a downgrade is never offered as an update`;
    }
    return check;
  }

  const status = latestVersion.version !== installed.version ? 'update-available' : 'current';
  return knownCheck(packageName, marketplace, installed, latestVersion, status);
}

/** A check whose both sides are known. @internal */
function knownCheck(
  packageName: string,
  marketplace: string,
  installed: ResolvedPackageVersion,
  latest: ResolvedPackageVersion,
  status: 'current' | 'update-available'
): UpdateCheckResult {
  return {
    packageName,
    installedVersion: installed.version,
    latestVersion: latest.version,
    hasUpdate: status === 'update-available',
    marketplace,
    status,
    installedVersionSource: installed.source,
    latestVersionSource: latest.source,
  };
}

/** A check that could not be answered, and why. @internal */
function unknownCheck(
  packageName: string,
  installed: ResolvedPackageVersion | undefined,
  note: string
): UpdateCheckResult {
  return {
    packageName,
    installedVersion: installed?.version ?? '',
    latestVersion: '',
    hasUpdate: false,
    marketplace: '',
    status: 'unknown',
    ...(installed && { installedVersionSource: installed.source }),
    note,
  };
}

/** The one result for a named package missing from the requested scope. @internal */
function notInScope(packageName: string): UpdateCheckResult {
  return unknownCheck(packageName, undefined, 'not installed in this scope');
}

/** Join two optional notes into one sentence list. @internal */
function joinNotes(first: string, second: string | undefined): string {
  return second ? `${first}; ${second}` : first;
}

/**
 * Read a directory without throwing on `ENOENT`. Returns an empty array
 * when the directory does not exist so the update flow works cleanly on
 * a fresh dorkHome with no installed packages.
 */
async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}
