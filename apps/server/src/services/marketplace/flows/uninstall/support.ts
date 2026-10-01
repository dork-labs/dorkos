/**
 * The uninstall flow's request and result, the ports it removes side effects
 * through, what its steps pass each other, and the error when no install of
 * the package is found.
 *
 * @module services/marketplace/flows/uninstall/support
 */
import { stat } from 'node:fs/promises';
import type { Logger } from '@dorkos/shared/logger';
import type { AgentRemovedSummary } from '@dorkos/shared/marketplace-schemas';
import type { MarketplacePackageManifest, PackageType } from '@dorkos/marketplace';
import type { InstalledFiles } from '../../lib/records/installed-files.js';

/** A request to uninstall a marketplace package. */
export interface UninstallRequest {
  /** Package name to uninstall. */
  name: string;
  /** Also remove the files you and your agents added or changed. */
  purge?: boolean;
  /** Project path for project-local uninstalls. */
  projectPath?: string;
  /**
   * Internal (installer-only): this removal is the first half of a replace
   * (the installer's `update()`), not a removal. It keeps `ui.shapes.active`
   * intact and leaves an agent package's agent registered, because the same
   * package lands back at the same path moments later. The HTTP route's body
   * schema does not expose it, so external callers always get the full
   * removal.
   */
  replacing?: boolean;
  /**
   * Internal (installer-only), read only with `replacing`: the bundled extension
   * ids the incoming version still carries. An update from the same plugin
   * keeps those extensions on and keeps the person's approval to run them, since
   * the same copy lands back at the same path; every other bundled extension
   * (one the new version drops) is turned off and its approval forgotten, so it
   * asks again if it ever returns. Absent means none is kept: a replace that
   * does not say what the new version carries forgets everything, as a plain
   * uninstall does.
   */
  retainedExtensionIds?: readonly string[];
  /**
   * Internal (installer-only): the exact install root to remove, when the
   * caller already resolved which installation it means — the installer's
   * `update()` replacing the installation an update check found. See
   * `LocateInstallInput.installRoot`; not exposed by the HTTP body schema.
   */
  installRoot?: string;
}

/** The outcome of a successful uninstall. */
export interface UninstallResult {
  ok: boolean;
  packageName: string;
  /** Number of entries moved out of the install root (a whole directory counts once). */
  removedFiles: number;
  /**
   * Absolute paths kept on disk because `purge` was false: the files you and
   * your agents added or changed, collapsed to the highest directory whose
   * whole contents were kept.
   */
  preservedData: string[];
  /** Set when uninstalling an agent package removed the agent from the team. */
  agentRemoved?: AgentRemovedSummary;
  /**
   * Absolute paths of files kept because the install had no record and nothing
   * proved whether they were the package's or the person's (DOR-2322).
   */
  unproven?: string[];
  /** Non-fatal notes: cleanup the recovery sweep will finish, files moved back. */
  warnings?: string[];
}

/**
 * The agent-registry surface the uninstall flow uses to take an uninstalled
 * agent package's agent off the team, and to put it back when the uninstall
 * rolls back after that step.
 */
export interface UninstallAgentRegistry {
  /**
   * Unregister the agent registered at `projectPath` (the full cascade).
   *
   * @returns Its id and whether its manifest was kept and the folder denied, or
   *   `null` when no agent is registered there.
   */
  unregisterAtPath(projectPath: string): Promise<{ id: string; directoryDenied: boolean } | null>;
  /** Register the agent at `projectPath` again from its `agent.json`. */
  restoreAtPath(projectPath: string): Promise<void>;
}

/**
 * Minimal {@link ExtensionManager} surface required by the uninstall flow.
 * Avoids importing the concrete class so tests can mock with `vi.fn()`.
 */
export interface UninstallExtensionManager {
  /**
   * The copy of this extension id discovery currently resolved, if any. Read so
   * that removing a package never touches a copy of the same id that lives
   * somewhere else (DOR-2383: another plugin, or a direct install).
   */
  get(id: string): { path: string } | undefined;
  disable(id: string): Promise<unknown>;
  /**
   * Drop the person's standing approval for this extension to run code inside
   * DorkOS (DOR-516), because the code it was given to is going away.
   *
   * `installRoot` is the package being removed: an approval recorded for a copy
   * outside it belongs to another package carrying the same id, and is kept.
   */
  forgetRunApproval(id: string, installRoot?: string): Promise<void>;
}

/**
 * Minimal {@link AdapterManager} surface required by the uninstall flow.
 */
export interface UninstallAdapterManager {
  removeAdapter(id: string, options?: { forgetHistory?: boolean }): Promise<void>;
}

/**
 * Person-scoped active-Shape surface the uninstall flow uses to keep
 * `ui.shapes.active` honest when the active Shape is removed. Optional on the
 * deps so non-Shape-aware callers (and most tests) need not supply it; when
 * absent, uninstalling a Shape simply skips the deactivation step.
 */
export interface UninstallShapeDeactivator {
  /** The currently-active Shape name (`ui.shapes.active`), or `null`. */
  getActiveShapeName(): string | null;
  /** Clear `ui.shapes.active` (set it to `null`). */
  clearActiveShape(): void;
}

/**
 * Schedule-teardown surface the uninstall flow uses to delete the schedules a
 * Shape created (stamped with its provenance marker) when that Shape is removed
 * — so a Shape's 15-minute tick never keeps firing after the Shape is gone.
 * Optional on the deps: a Shape-unaware caller (and most tests) omit it, in
 * which case a Shape uninstall simply skips schedule cleanup.
 */
export interface UninstallShapeScheduleTeardown {
  /**
   * Delete every schedule stamped with this Shape's provenance marker.
   *
   * @param shapeName - The Shape whose schedules to delete.
   * @returns The names of the schedules deleted.
   */
  deleteSchedulesForShape(shapeName: string): Promise<string[]>;
}

/** Dependencies for {@link UninstallFlow}. */
export interface UninstallFlowDeps {
  dorkHome: string;
  extensionManager: UninstallExtensionManager;
  adapterManager: UninstallAdapterManager;
  /** Active-Shape state hooks; omit when the caller does not manage Shapes. */
  shapeDeactivator?: UninstallShapeDeactivator;
  /** Deletes a removed Shape's schedules; omit when the caller does not manage Shapes. */
  shapeScheduleTeardown?: UninstallShapeScheduleTeardown;
  /** Takes an uninstalled agent package's agent off the team; omit when mesh is off. */
  agentRegistry?: UninstallAgentRegistry;
  /**
   * Rebuild the installed-files record of an install made before records
   * existed (spec §9); `null` when none can be rebuilt.
   */
  rebuildLegacy?: (installRoot: string) => Promise<InstalledFiles | null>;
  logger: Logger;
}

/** The side-effect inputs, captured from the live root before anything moves. */
export interface SideEffectInputs {
  /** Bundled extension ids (`.dork/extensions/<id>/`). */
  extensionIds: string[];
  /** Skill directories this install generated for its schedules. */
  generatedSchedulePaths: string[];
}

/** A located install with its parsed manifest (when one exists). */
export interface LocatedPackage {
  installRoot: string;
  manifest: MarketplacePackageManifest | null;
  inferredType: PackageType;
}

/** Thrown when {@link UninstallFlow.uninstall} cannot find the requested package. */
export class PackageNotInstalledError extends Error {
  /**
   * Build a `PackageNotInstalledError` for the supplied package name.
   *
   * @param name - The package name that could not be located on disk.
   */
  constructor(public readonly name: string) {
    super(`Package not installed: ${name}`);
    this.name = 'PackageNotInstalledError';
  }
}

/** Returns true if `target` exists on disk. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
