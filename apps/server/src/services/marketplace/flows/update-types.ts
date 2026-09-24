/**
 * The types the marketplace update flow speaks: what it needs injected, what a
 * request asks for, and what a check answers. Split from `update.ts` so the flow
 * module holds only the orchestrator.
 *
 * @module services/marketplace/flows/update-types
 */
import type { MarketplaceJson, PackageType, VersionSource } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import type {
  InstallRequest,
  InstallResult,
  LatestResolution,
  MarketplaceSource,
  PermissionPreview,
  ResolveLatestOptions,
} from '../types.js';
import type { DisclosedEffects } from '../disclosed-effects.js';
import type { InstallationRecord, PackageScope } from '../installed-scanner.js';

/**
 * Structural interface for the forward-declared `MarketplaceInstaller`.
 * Declared here so the update flow can be wired against either the real
 * installer or a test double without a circular import.
 */
export interface InstallerLike {
  /**
   * Update an installed package: uninstall it as the first half of a replace
   * and reinstall, keeping the files the person and their agents added or
   * changed (DOR-2245).
   */
  update(req: InstallRequest): Promise<InstallResult>;
  /**
   * Work out what installing a package now would give, without installing.
   * Never throws: a failure is an `unresolved` result with a reason.
   */
  resolveLatest(req: InstallRequest, opts: ResolveLatestOptions): Promise<LatestResolution>;
  /**
   * Stage the package a request resolves to and say every effect installing it
   * would have, without installing. Used to show a person what an update's new
   * version would run before they approve it (DOR-2195).
   */
  preview(req: InstallRequest): Promise<{ preview: PermissionPreview }>;
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

/** A request to check one package (and optionally apply its update). */
export interface UpdateRequest {
  /** The package name, as the update check names it (`updateNameOf`). */
  name: string;
  /**
   * The installation of that name the caller resolved ({@link pickInstallation}),
   * or `undefined` when the name is not installed in the caller's scope. The
   * caller resolves it so it can authorize and notify against the installation
   * that will actually change.
   */
  installation: InstallationRecord | undefined;
  /** Apply the update (default: advisory only). */
  apply?: boolean;
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
  /**
   * The installation is a symbolic link to a developer's working copy. Present,
   * and `true`, only then: its check is always `unknown` with
   * `LINKED_INSTALL_NOTE`, and it is never reinstalled, so a reader can tell
   * "never checked, by design" from "the check failed".
   */
  linked?: true;
  /** Set when an apply reinstalled this installation: what is installed now. */
  applied?: InstallResult;
  /** Set when an apply tried to reinstall this installation and failed: why. */
  applyError?: string;
  /**
   * What the new version would run (its hooks, scheduled jobs and MCP servers),
   * read from the staged new version. Set only on an `update-available` check
   * planned with `disclose`, which is what an approval card shows and binds.
   */
  disclosed?: DisclosedEffects | null;
}

/** A request to check (and optionally apply) a set of scanned installations. */
export interface InstallationUpdatesRequest {
  /** The installations to check, from one `scanInstallationRecords` call. */
  installations: InstallationRecord[];
  /** Reinstall every installation whose check is `update-available`. */
  apply?: boolean;
  /**
   * Also stage each `update-available` installation's new version and record
   * what it would run ({@link InstallationUpdateCheck.disclosed}). A new version
   * that cannot be read is `unknown`, so it can never be approved unseen.
   */
  disclose?: boolean;
}

/**
 * A checked set of installations, ready to apply ({@link UpdateFlow.applyPlan}).
 * The checks are what a caller shows; the steps carry the reinstall requests,
 * which stay inside the flow.
 */
export interface UpdatePlan {
  /** One per installation, in the order given. */
  checks: InstallationUpdateCheck[];
  /** @internal The installation and reinstall request behind each check. */
  readonly steps: readonly { record: InstallationRecord; request?: InstallRequest }[];
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
