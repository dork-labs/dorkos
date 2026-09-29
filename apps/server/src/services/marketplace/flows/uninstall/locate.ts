/**
 * Find the install root an uninstall acts on, in every scope it may be in.
 *
 * @module services/marketplace/flows/uninstall/locate
 */
import path from 'node:path';
import { PACKAGE_TEXT_MAX_BYTES, readTextFileWithin } from '@dorkos/shared/bounded-read';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import {
  hasPackageIdentity,
  installRootCandidates,
  type InstallRootCandidate,
} from '../../lib/locate-install.js';
import { hasInstallRecords } from '../../recovery/install-recovery.js';
import {
  type LocatedPackage,
  PackageNotInstalledError,
  type UninstallFlowDeps,
  type UninstallRequest,
} from './support.js';

/**
 * Read and parse `.dork/manifest.json` from an install root, returning
 * `null` if the file is missing or unparseable. Validation is the
 * installer's job — we only need the type for routing.
 */
export async function readManifestIfPresent(
  installRoot: string
): Promise<MarketplacePackageManifest | null> {
  try {
    const raw = await readTextFileWithin(
      path.join(installRoot, PACKAGE_MANIFEST_PATH),
      PACKAGE_TEXT_MAX_BYTES,
      'The manifest'
    );
    return JSON.parse(raw) as MarketplacePackageManifest;
  } catch {
    return null;
  }
}

/** Finds the install an uninstall acts on, on the flow's dependencies. */
export class UninstallLocator {
  constructor(private readonly deps: UninstallFlowDeps) {}

  /**
   * Search the canonical install locations for a package matching `req.name`
   * and return the first match. Reads `dork-package.json` to determine the
   * package type when one is present, otherwise infers it from the layout.
   *
   * First-match wins across the probe order (the project scope's roots
   * `plugins` → `agents` → `shapes`, then the global scope's):
   * {@link UninstallRequest} carries no
   * package type, so when two different-type packages share a name (e.g. a
   * plugin *and* a Shape both called "linear-ops"), an uninstall by name always
   * resolves to the earlier root and the later one stays untouched. That
   * cross-type collision is surfaced as a non-blocking warning at install time
   * by the conflict detector's package-name rule, so the ambiguity is visible
   * before it is ever created.
   *
   * @param req - The uninstall request.
   * @param skip - Roots already settled and found empty in this uninstall.
   * @throws {PackageNotInstalledError} When no candidate outside `skip` holds
   *   the package or records of it.
   * @internal
   */
  async locate(
    req: UninstallRequest,
    skip: ReadonlySet<string> = new Set()
  ): Promise<LocatedPackage> {
    const candidates = this.candidatePaths(req);
    for (const candidate of candidates) {
      if (skip.has(candidate.installRoot)) continue;
      // A root holding only files an earlier uninstall kept is not an install
      // (DOR-2245); records beside a target still are, so recovery settles them.
      const present =
        (await hasPackageIdentity(candidate.installRoot)) ||
        (await hasInstallRecords(candidate.installRoot));
      if (!present) continue;
      const manifest = await readManifestIfPresent(candidate.installRoot);
      return {
        installRoot: candidate.installRoot,
        manifest,
        inferredType: manifest?.type ?? candidate.inferredType,
      };
    }
    throw new PackageNotInstalledError(req.name);
  }

  /**
   * Build the ordered list of paths to probe for an installed package: every
   * install root (`plugins`, `agents`, `shapes`) under the request's project
   * scope when it has one, then every install root under the global
   * `dorkHome`.
   *
   * Both halves come from {@link installRootsUnder}, so a package type can
   * never install somewhere the probe does not look — the drift that first hid
   * Shapes globally, and then hid project-scoped agents, which the project half
   * used to miss by hardcoding `plugins` (DOR-994). A project's roots stay
   * ahead of the global ones because a project install shadows a global package
   * of the same name for that project, matching the installed scanner's merged
   * view, which the update flow checks.
   *
   * Shared with `MarketplaceInstaller.update()`, which probes the same order to
   * decide which target to lock across its whole uninstall-then-install round
   * trip — two orders would mean it locked a directory this flow never touches.
   *
   * @internal
   */
  candidatePaths(req: UninstallRequest): InstallRootCandidate[] {
    return installRootCandidates({
      dorkHome: this.deps.dorkHome,
      name: req.name,
      projectPath: req.projectPath,
      installRoot: req.installRoot,
    });
  }
}
