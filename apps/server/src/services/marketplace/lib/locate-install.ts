/**
 * Where an installed marketplace package is found on disk, by name.
 *
 * An {@link UninstallRequest} carries no package type, so finding an install
 * means probing the canonical roots in a fixed order and taking the first hit.
 * The order is the single thing this module owns, and it has to be one thing:
 * the uninstall flow probes to decide what to remove, and
 * `MarketplaceInstaller.update()` probes to decide which target to lock for the
 * whole uninstall-then-install round trip (DOR-1722). Two probe orders would
 * mean `update()` serialising on a directory the uninstall then does not touch
 * — including, since DOR-994 widened the project scope to every install root,
 * the case where the update locks a global `plugins/foo` while the uninstall
 * removes the project's `agents/foo`.
 *
 * The roots themselves are not owned here: they come from
 * {@link installRootsUnder}, so a package type can never install somewhere this
 * probe does not look.
 *
 * @module services/marketplace/lib/locate-install
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { PackageType } from '@dorkos/marketplace';
import { installRootsUnder, projectScopeRoot } from './install-roots.js';

/** Identifies a package to look for on disk. */
export interface LocateInstallInput {
  /** Resolved DorkOS data directory (the global scope root). */
  dorkHome: string;
  /** Canonical package name (the manifest's `name`). */
  name: string;
  /** Project path, when the caller is looking for a project-scoped install too. */
  projectPath?: string;
}

/** A place an install of a given name could be, and the type that root implies. */
export interface InstallRootCandidate {
  installRoot: string;
  /**
   * The type implied by the root itself, used only when the package's own
   * manifest is missing or unreadable — the manifest's `type` always wins.
   */
  inferredType: PackageType;
}

/**
 * Build the ordered list of paths to probe for an installed package: every
 * install root (`plugins`, `agents`, `shapes`) under the request's project
 * scope when it has one, then every install root under the global `dorkHome`.
 *
 * A project's roots stay ahead of the global ones because a project install
 * shadows a global package of the same name for that project, matching the
 * installed scanner's merged view and the update flow's walk. First-match-wins
 * across that order, so when two different-type packages share a name (a plugin
 * *and* a Shape both called "linear-ops"), a lookup by name always resolves to
 * the earlier root. The conflict detector surfaces that collision as a warning
 * at install time, so the ambiguity is visible before it is created.
 *
 * @param input - The package to look for and the scopes to look under.
 * @returns The candidate install roots, in probe order.
 */
export function installRootCandidates(input: LocateInstallInput): InstallRootCandidate[] {
  const scopeRoots = input.projectPath
    ? [projectScopeRoot(input.projectPath), input.dorkHome]
    : [input.dorkHome];
  return scopeRoots.flatMap((scopeRoot) =>
    installRootsUnder(scopeRoot).map(({ dir, representativeType }) => ({
      installRoot: path.join(dir, input.name),
      inferredType: representativeType,
    }))
  );
}

/**
 * Find where a package of this name is installed, or `null` when none of the
 * candidate roots exists.
 *
 * @param input - The package to look for and the scopes to look under.
 * @returns The first existing install root in probe order, or `null`.
 */
export async function locateInstallRoot(input: LocateInstallInput): Promise<string | null> {
  for (const candidate of installRootCandidates(input)) {
    if (await pathExists(candidate.installRoot)) return candidate.installRoot;
  }
  return null;
}

/**
 * Returns true when `target` exists on disk (file or directory).
 *
 * @internal
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
