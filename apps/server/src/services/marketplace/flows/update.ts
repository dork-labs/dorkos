/**
 * Marketplace package update flow.
 *
 * Advisory by default: checks installed packages, works out what installing
 * each one right now would give, and returns the comparison without touching
 * any installed package. When `apply` is set, the flow delegates reinstallation
 * of every installation with an update to an injected {@link InstallerLike},
 * which runs the uninstall-without-purge → install pattern that preserves
 * `.dork/data/` and `.dork/secrets.json` (ADR-0233).
 *
 * Two doors lead here, and both check {@link InstallationRecord}s from the
 * installed scanner's one walk rather than walking install roots themselves:
 *
 * - {@link UpdateFlow.run} — one package by name, in one scope (the
 *   per-package route).
 * - {@link UpdateFlow.checkInstallations} — every installation it is handed,
 *   one result per installation, each carrying that installation's identity
 *   (the all-packages door). The caller scans once and passes the records in.
 *
 * Either way, an apply reinstalls an installation in the scope it was found in —
 * never the scope the request named — so updating a global package from a
 * project never moves it into that project (ADR 260923-163034).
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
import { gt as semverGt, valid as semverValid } from 'semver';
import {
  isRealCommitSha,
  resolvePackageVersion,
  type MarketplaceJson,
  type MarketplaceJsonEntry,
  type PackageType,
  type ResolvedPackageVersion,
  type VersionSource,
} from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { mapWithConcurrency } from '@dorkos/shared/map-with-concurrency';
import { updateNameOf } from '../lib/install-roots.js';
import type {
  InstallRequest,
  InstallResult,
  LatestResolution,
  MarketplaceSource,
  ResolveLatestOptions,
} from '../types.js';
import {
  scanInstallationRecords,
  type InstallationRecord,
  type PackageScope,
} from '../installed-scanner.js';

/**
 * How long a commit lookup or a marketplace index fetch is shared between
 * checks. A named `dorkos update <name>` and the app's per-row Update each send
 * one request per package, so a memo scoped to one call would never span them;
 * one scoped to the instance with this TTL is "shared within one CLI run or UI
 * burst". Without a refresh, a push made within the last minute can still read
 * as current.
 */
export const UPDATE_MEMO_TTL_MS = 60_000;

/**
 * How many installations {@link UpdateFlow.checkInstallations} checks at once.
 *
 * Each check may `git ls-remote` a repository or stage a package into the
 * cache, and those are bounded by the fetcher's own timeouts. Four at a time
 * keeps a whole-install check from opening one git process per installation,
 * while a slow or unreachable repository holds only its own slot. Concurrent
 * checks of one repository share a single in-flight lookup through the memo —
 * including a failing one, which is never kept once it settles.
 */
export const UPDATE_CHECK_CONCURRENCY = 4;

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

/** A request to check one package by name (and optionally apply its update). */
export interface UpdateRequest {
  /** The package name, as the update check names it (`updateNameOf`). */
  name: string;
  /** Apply the update (default: advisory only). */
  apply?: boolean;
  /**
   * Project path for project-local installs. Adds that project's own install
   * roots to the scan, where a project install takes precedence over a global
   * package of the same name. An applied reinstall stays in the scope the
   * package was found in: a global package is reinstalled globally.
   */
  projectPath?: string;
}

/** The composite result of a one-package update check. */
export interface UpdateResult {
  checks: UpdateCheckResult[];
  /** Populated only when `apply: true`; one entry per successful reinstall. */
  applied: InstallResult[];
}

/**
 * One installation's check, with the installation's identity and, after an
 * apply, what happened to it. The identity fields are the installed list's own
 * (`GET /api/marketplace/installed`), so `installPath` joins the two.
 */
export interface InstallationUpdateCheck extends UpdateCheckResult {
  /** Absolute path to the installation; unique per installation, unlike the name. */
  installPath: string;
  /** The installed package's type. */
  type: PackageType;
  /** `global`, or `agent-local` / `override` for a project or agent install. */
  scope: PackageScope;
  /** The project directory holding a non-global installation. */
  agentPath?: string;
  /** Registered agent id owning `agentPath`, when the scan knew it. */
  agentId?: string;
  /** Registered agent display name owning `agentPath`, when the scan knew it. */
  agentName?: string;
  /** Set when an apply reinstalled this installation: what is installed now. */
  applied?: InstallResult;
  /** Set when an apply tried to reinstall this installation and failed: why. */
  applyError?: string;
}

/** A request to check (and optionally apply) a set of scanned installations. */
export interface InstallationUpdatesRequest {
  /** The installations to check, from one `scanInstallationRecords` call. */
  installations: InstallationRecord[];
  /** Reinstall every installation whose check is `update-available`. */
  apply?: boolean;
}

/** The result of {@link UpdateFlow.checkInstallations}. */
export interface InstallationUpdatesResult {
  /** One per installation, in the order the installations were given. */
  checks: InstallationUpdateCheck[];
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
 * A named package is not installed anywhere the caller can see: in no scope at
 * all for the per-package route (which can see every scope, while
 * {@link UpdateFlow.run} sees only its own and answers "not installed in this
 * scope"), or not among the installations in view for
 * {@link selectInstallations}. Both routes answer it as a 404.
 */
export class PackageNotInstalledForUpdateError extends Error {
  /** Every name that could not be found, in the order the caller gave them. */
  public readonly packageNames: string[];

  /**
   * Build a `PackageNotInstalledForUpdateError` for one or more package names.
   *
   * @param names - The package name, or names, that could not be located.
   */
  constructor(names: string | string[]) {
    const packageNames = typeof names === 'string' ? [names] : names;
    super(
      `${packageNames.length === 1 ? 'Package' : 'Packages'} not installed: ${packageNames.join(', ')}`
    );
    this.name = 'PackageNotInstalledForUpdateError';
    this.packageNames = packageNames;
  }
}

/**
 * The name an installation is checked and applied under ({@link updateNameOf}):
 * its manifest name when that is a valid package name, else its directory name.
 *
 * @param record - A scanned installation.
 * @returns The installation's update name.
 */
export function installationUpdateName(record: InstallationRecord): string {
  return updateNameOf(record.package.name, record.package.installPath);
}

/**
 * Narrow scanned installations to the named packages. With no names, or an
 * empty list, every installation is kept. A name matches every installation in
 * view that goes by it ({@link installationUpdateName}), so the same package in
 * two scopes is two installations.
 *
 * @param records - The installations one scan found.
 * @param names - The package names to keep; omit for all of them.
 * @returns The matching installations, in scan order.
 * @throws {PackageNotInstalledForUpdateError} Naming every name that matched
 *   nothing, before anything is checked.
 */
export function selectInstallations(
  records: InstallationRecord[],
  names?: readonly string[]
): InstallationRecord[] {
  if (!names || names.length === 0) return records;
  const wanted = new Set(names);
  const selected = records.filter((record) => wanted.has(installationUpdateName(record)));
  const found = new Set(selected.map(installationUpdateName));
  const missing = [...wanted].filter((name) => !found.has(name));
  if (missing.length > 0) throw new PackageNotInstalledForUpdateError(missing);
  return selected;
}

/**
 * Advisory-by-default update orchestrator for marketplace packages.
 *
 * {@link UpdateFlow.run} checks one package by name; {@link
 * UpdateFlow.checkInstallations} checks every installation it is handed. Both
 * reinstall `update-available` installations when asked to apply, each in its
 * own scope. One instance serves the whole server, and it holds the
 * commit-lookup and index memos (see {@link UPDATE_MEMO_TTL_MS}).
 */
export class UpdateFlow {
  private readonly commitMemo = new Map<string, MemoEntry<string>>();
  private readonly indexMemo = new Map<string, MemoEntry<MarketplaceJson>>();

  constructor(private readonly deps: UpdateFlowDeps) {}

  /**
   * Check one package by name — the per-package route's door.
   *
   * Scans the global scope plus, with a `projectPath`, that project's merged
   * view. When the name is installed in both, the project's installation wins
   * (it shadows the global one for that project). An apply reinstalls the
   * matched installation in ITS scope: a global package is reinstalled
   * globally even when the request named a project. A failed reinstall throws,
   * so the route can map the error to a status.
   *
   * @param req - The package name, apply flag and project path.
   * @returns One check (or one `unknown` "not installed in this scope" check
   *   for a name missing from the scope), and the reinstall when applied.
   */
  async run(req: UpdateRequest): Promise<UpdateResult> {
    const records = await scanInstallationRecords(
      this.deps.dorkHome,
      req.projectPath ? { projectPath: req.projectPath } : { agents: [] }
    );
    const named = records.filter((record) => installationUpdateName(record) === req.name);
    const match = named.find((record) => record.package.agentPath !== undefined) ?? named[0];
    if (!match) return { checks: [notInScope(req.name)], applied: [] };

    const { check, request } = await this.checkRecord(match);
    const applied: InstallResult[] = [];
    if (req.apply) {
      try {
        if (check.status === 'update-available' && request) {
          applied.push(await this.reinstall(match, request));
        }
      } finally {
        // What was just installed changes what the next check should see.
        this.clearMemos();
      }
    }
    return { checks: [check], applied };
  }

  /**
   * Check every installation handed in — the all-packages door. The caller
   * scans once (`scanInstallationRecords`) and passes the records, so a list and
   * its check never walk twice.
   *
   * Checks run {@link UPDATE_CHECK_CONCURRENCY} at a time and come back in the
   * order given, each carrying its installation's identity. Nothing is dropped:
   * an installation that cannot be checked is `unknown`, with the reason.
   *
   * With `apply`, every `update-available` installation is reinstalled one at a
   * time, in order, in its own scope. A failed reinstall is recorded on that
   * installation as `applyError` and the rest carry on, so one broken package
   * can never hide what already landed.
   *
   * @param req - The scanned installations, and whether to apply.
   * @returns One check per installation.
   */
  async checkInstallations(req: InstallationUpdatesRequest): Promise<InstallationUpdatesResult> {
    const planned = await mapWithConcurrency(
      req.installations,
      UPDATE_CHECK_CONCURRENCY,
      (record) => this.checkRecord(record)
    );
    const checks = planned.map(({ check }, i) =>
      withIdentity(check, req.installations[i]!.package)
    );

    if (req.apply) {
      try {
        for (const [i, { check, request }] of planned.entries()) {
          if (check.status !== 'update-available' || !request) continue;
          const record = req.installations[i]!;
          try {
            checks[i]!.applied = await this.reinstall(record, request);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.deps.logger.warn('update-flow: reinstall failed', {
              packageName: check.packageName,
              installPath: record.package.installPath,
              error: reason,
            });
            checks[i]!.applyError = reason;
          }
        }
      } finally {
        this.clearMemos();
      }
    }

    return { checks };
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
   * Reinstall one installation in the scope it was found in: its project for a
   * project or agent install, none for a global one.
   *
   * @internal
   */
  private reinstall(record: InstallationRecord, request: InstallRequest): Promise<InstallResult> {
    return this.deps.installer.update({ ...request, projectPath: record.package.agentPath });
  }

  /**
   * Check one installation: find where it would be reinstalled from, ask the
   * installer what that would give, and compare by Claude Code's chain. The
   * installed side is the record's declared version and install sidecar.
   *
   * @internal
   */
  private async checkRecord(record: InstallationRecord): Promise<PlannedCheck> {
    const name = installationUpdateName(record);
    const recorded = record.metadata;
    const installedCommit = isRealCommitSha(recorded?.commitSha) ? recorded.commitSha : undefined;
    const installed = resolvePackageVersion({
      declaredVersion: record.declaredVersion,
      entryVersion: recorded?.entryVersion,
      commitSha: installedCommit,
    });

    const target = await this.findTarget(name, recorded);
    if (target.kind === 'none') {
      this.deps.logger.warn('update-flow: no marketplace entry found for package', {
        packageName: name,
        note: target.note,
      });
      return { check: unknownCheck(name, installed, target.note) };
    }

    const request: InstallRequest =
      target.kind === 'marketplace'
        ? { name, marketplace: target.marketplaceName }
        : { name, source: target.source };
    const latest = await this.deps.installer.resolveLatest(request, {
      installed: {
        commitSha: installedCommit,
        entryVersion: recorded?.entryVersion,
        sourceKey: recorded?.sourceKey,
      },
      commitLookup: (cloneUrl, ref) => this.lookupCommit(cloneUrl, ref),
    });

    const marketplace = target.kind === 'marketplace' ? target.marketplaceName : '';
    const check = compareVersions(name, marketplace, installed, latest);
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
  private async findTarget(
    name: string,
    recorded: InstallationRecord['metadata']
  ): Promise<UpdateTarget> {
    if (!recorded?.installedFrom && recorded?.sourceRepo) {
      // No "apply reinstalls from the default branch" note: both direct forms
      // (`name@url`, `github:`) resolve to a ref-less url source, so a recorded
      // key is always the default branch (`ref: 'HEAD'`; `'main'` in sidecars
      // written before DOR-2248), `subpath: ''`, and apply matches it.
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
      const entry = await this.findEntry(source, name, unreachable);
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
 * A check plus the installation it belongs to, in the installed list's own
 * field names so `installPath` joins the two. @internal
 */
function withIdentity(
  check: UpdateCheckResult,
  installed: InstallationRecord['package']
): InstallationUpdateCheck {
  return {
    ...check,
    installPath: installed.installPath,
    type: installed.type,
    scope: installed.scope ?? 'global',
    ...(installed.agentPath !== undefined && { agentPath: installed.agentPath }),
    ...(installed.agentId !== undefined && { agentId: installed.agentId }),
    ...(installed.agentName !== undefined && { agentName: installed.agentName }),
  };
}
