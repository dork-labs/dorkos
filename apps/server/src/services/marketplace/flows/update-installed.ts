/**
 * The all-packages update door, independent of the surface that opens it.
 *
 * `GET` / `POST /api/marketplace/updates` and the marketplace MCP tools
 * (DOR-2195) run the same steps: scan the installations in view once, narrow
 * them, authorize every reinstall before anything touches the network, check
 * and apply through {@link UpdateFlow.checkInstallations}, and send one
 * `onPluginsChanged` per reinstall that landed. Only how a surface asks
 * permission differs (the HTTP tier gate, the MCP confirmation provider), so
 * that one step is passed in as a {@link ReinstallGate}.
 *
 * ## Two spellings of one project
 *
 * The scan and every reinstall use the CANONICAL project path the boundary
 * check resolved, so an installation's `installPath` and `agentPath` are the
 * same however the caller spelled the directory, and `GET /installed` rows join
 * to these checks. The gate and the notification carry the CALLER's spelling
 * for the requested project (see `confineProjectPath` in `routes/marketplace.ts`):
 * an approval token binds to the arguments the caller sent, and listeners match
 * the project the way the person picked it. {@link callerSpelling} maps one to
 * the other; an agent's project is spelled as the registry has it.
 *
 * @module services/marketplace/flows/update-installed
 */
import type { NotifyPluginsChanged } from '../types.js';
import {
  scanInstallationRecords,
  type AgentScopeRef,
  type InstallationRecord,
} from '../installed-scanner.js';
import {
  installationUpdateName,
  selectInstallations,
  type InstallationSelector,
  type InstallationUpdatesResult,
  type UpdateFlow,
} from './update.js';

/** What the all-packages door needs from the server. */
export interface InstalledUpdatesDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** The server's one update flow. */
  updateFlow: Pick<UpdateFlow, 'checkInstallations'>;
  /** Registered agents whose projects are in view when no project is named. */
  listAgentScopes?: () => AgentScopeRef[];
  /** The post-change notifier every surface that mutates installs must fire. */
  onPluginsChanged: NotifyPluginsChanged;
}

/** Which project a request named, in both spellings. */
export interface RequestedProject {
  /** The canonical path the boundary check resolved; scans and effects use it. */
  projectPath?: string;
  /** The path as the caller sent it; the gate and the notification use it. */
  callerProjectPath?: string;
}

/** The per-package input a reinstall is authorized with, as `marketplace.install`. */
export interface ReinstallGateInput {
  name: string;
  projectPath?: string;
}

/**
 * Ask whether one reinstall may run. Returns `undefined` to allow it, or the
 * surface's refusal, which ends the whole batch before anything runs.
 */
export type ReinstallGate<R> = (input: ReinstallGateInput) => R | undefined;

/**
 * The installations one update request covers, from ONE scan: the requested
 * project's merged view, or every scope (the global roots plus each registered
 * agent's project). The same two views `GET /installed` lists.
 *
 * @param deps - The server's update dependencies.
 * @param projectPath - The canonical project path, when one was named.
 * @returns One record per installation in view.
 */
export function scanUpdateView(
  deps: Pick<InstalledUpdatesDeps, 'dorkHome' | 'listAgentScopes'>,
  projectPath: string | undefined
): Promise<InstallationRecord[]> {
  return scanInstallationRecords(
    deps.dorkHome,
    projectPath ? { projectPath } : { agents: deps.listAgentScopes?.() ?? [] }
  );
}

/**
 * The spelling an installation's project goes by toward the gate and the
 * listeners: the caller's own for the requested project, the registry's for an
 * agent's, none for a global installation.
 *
 * @param agentPath - The installation's (canonical) project, if any.
 * @param requested - The project the request named, in both spellings.
 * @returns The path to authorize and notify with.
 */
export function callerSpelling(
  agentPath: string | undefined,
  requested: RequestedProject
): string | undefined {
  return agentPath !== undefined && agentPath === requested.projectPath
    ? requested.callerProjectPath
    : agentPath;
}

/**
 * Check every installation in view. Advisory: no installed package changes,
 * though a check may stage a newer version into the package cache.
 *
 * @param deps - The server's update dependencies.
 * @param projectPath - The canonical project path, when one was named.
 * @returns One check per installation, in scan order.
 */
export async function checkInstalledUpdates(
  deps: InstalledUpdatesDeps,
  projectPath: string | undefined
): Promise<InstallationUpdatesResult> {
  const installations = await scanUpdateView(deps, projectPath);
  return deps.updateFlow.checkInstallations({ installations });
}

/**
 * Reinstall every stale installation in view, or the selected ones. Every
 * distinct reinstall is authorized first, with the per-package input, and the
 * first refusal ends the batch with nothing run. The result is the record of
 * what changed: each installation's `applied` or `applyError`.
 *
 * @param deps - The server's update dependencies.
 * @param req - The requested project and the selection.
 * @param gate - The surface's permission check for one reinstall.
 * @returns The refusal, or the per-installation result.
 * @throws {PackageNotInstalledForUpdateError} When a selected name or path is
 *   not in view, before any gate or check.
 */
export async function applyInstalledUpdates<R>(
  deps: InstalledUpdatesDeps,
  req: RequestedProject & InstallationSelector,
  gate: ReinstallGate<R>
): Promise<{ refused: R } | { result: InstallationUpdatesResult }> {
  const installations = selectInstallations(await scanUpdateView(deps, req.projectPath), req);

  const asked = new Set<string>();
  for (const record of installations) {
    const name = installationUpdateName(record);
    const projectPath = callerSpelling(record.package.agentPath, req);
    const key = `${name}\n${projectPath ?? ''}`;
    if (asked.has(key)) continue;
    asked.add(key);
    const refused = gate({ name, ...(projectPath !== undefined && { projectPath }) });
    if (refused !== undefined) return { refused };
  }

  const result = await deps.updateFlow.checkInstallations({ installations, apply: true });
  // One refresh per reinstall that landed, in that installation's scope, with
  // the RESOLVED manifest name (DOR-264). A failed reinstall changed nothing.
  for (const check of result.checks) {
    if (!check.applied) continue;
    deps.onPluginsChanged({
      projectPath: callerSpelling(check.agentPath, req),
      packageName: check.applied.packageName,
      action: 'install',
    });
  }
  return { result };
}
