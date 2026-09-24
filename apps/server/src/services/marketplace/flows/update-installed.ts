/**
 * The all-packages update door, independent of the surface that opens it.
 *
 * `GET` / `POST /api/marketplace/updates` and the marketplace MCP tools
 * (DOR-2195) share these steps: scan the installations in view once, narrow
 * them ({@link checkInstalledUpdates} for a read), apply, and send one
 * `onPluginsChanged` per reinstall that landed. How a surface gets permission
 * is passed in, and the two applies differ in WHEN they ask:
 *
 * - {@link applyInstalledUpdates} (the HTTP route) authorizes every reinstall
 *   per package, through a {@link ReinstallGate}, before any network work. The
 *   tier gate never shows a person anything, so there is nothing to read first.
 * - {@link applyApprovedUpdates} (the MCP tool) asks a person, through an
 *   {@link ApprovalGate}, so it checks first and stages each stale installation's
 *   new version: the card lists exactly what would change and everything the
 *   new versions would run, and each reinstall is then held to it.
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
import type { DisclosedEffects } from '../disclosed-effects.js';
import type { PackageScope } from '../installed-scanner.js';
import type { PackageType } from '@dorkos/marketplace';
import type { UpdateFlow } from './update.js';
import {
  installationUpdateName,
  selectInstallations,
  type InstallationSelector,
} from './update-selection.js';
import type { InstallationUpdatesResult } from './update-types.js';

/** What the all-packages door needs from the server. */
export interface InstalledUpdatesDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** The server's one update flow. */
  updateFlow: Pick<UpdateFlow, 'checkInstallations' | 'planInstallations' | 'applyPlan'>;
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
 * Ask whether one reinstall may run. Resolves `undefined` to allow it, or the
 * surface's refusal, which ends the whole batch before anything runs. Async
 * because the capability gate reads the caller's permissions fresh.
 */
export type ReinstallGate<R> = (input: ReinstallGateInput) => Promise<R | undefined>;

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
 * Check every installation in view, or the selected ones. Advisory: no
 * installed package changes, though a check may stage a newer version into the
 * package cache.
 *
 * @param deps - The server's update dependencies.
 * @param projectPath - The canonical project path, when one was named.
 * @param selector - Which installations to check; absent or empty keeps all.
 * @returns One check per selected installation, in scan order.
 * @throws {PackageNotInstalledForUpdateError} When a selected name or path is
 *   not in view, before anything is checked.
 */
export async function checkInstalledUpdates(
  deps: InstalledUpdatesDeps,
  projectPath: string | undefined,
  selector?: InstallationSelector
): Promise<InstallationUpdatesResult> {
  const installations = selectInstallations(await scanUpdateView(deps, projectPath), selector);
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
    const refused = await gate({ name, ...(projectPath !== undefined && { projectPath }) });
    if (refused !== undefined) return { refused };
  }

  const result = await deps.updateFlow.checkInstallations({ installations, apply: true });
  notifyApplied(deps, result, req);
  return { result };
}

/**
 * One refresh per reinstall that landed, in that installation's scope, with
 * the RESOLVED manifest name (DOR-264). A failed reinstall changed nothing.
 *
 * @param deps - The server's update dependencies.
 * @param result - The applied checks.
 * @param requested - The project the request named, in both spellings.
 */
function notifyApplied(
  deps: InstalledUpdatesDeps,
  result: InstallationUpdatesResult,
  requested: RequestedProject
): void {
  for (const check of result.checks) {
    if (!check.applied) continue;
    deps.onPluginsChanged({
      projectPath: callerSpelling(check.agentPath, requested),
      packageName: check.applied.packageName,
      action: 'install',
    });
  }
}

/**
 * One reinstall a person is asked to approve: which installation, from which
 * version to which, and what the new version would run. The approval binds the
 * installation (`installPath`, unique even where a plugin and an agent share a
 * name) and `disclosed`, and the reinstall is held to that disclosure.
 */
export interface ApprovableUpdate {
  /** The package, as the update names it. */
  packageName: string;
  /** The installation that would be replaced; its identity for the approval. */
  installPath: string;
  /** The installed package's type. */
  type: PackageType;
  /** `global`, or `agent-local` / `override` for a project's copy. */
  scope: PackageScope;
  /** The project holding a non-global installation, as the caller spells it. */
  projectPath?: string;
  /** The registered agent that project belongs to, when known. */
  agentName?: string;
  /** The version installed now. */
  installedVersion: string;
  /** The version the reinstall would install. */
  latestVersion: string;
  /** What the new version would run: its hooks, scheduled jobs and MCP servers. */
  disclosed: DisclosedEffects | null;
}

/**
 * Ask a person about the reinstalls an apply would make. Returns `undefined`
 * to allow all of them, or the surface's refusal, which ends the call with
 * nothing run.
 */
export type ApprovalGate<R> = (updates: ApprovableUpdate[]) => Promise<R | undefined>;

/**
 * Reinstall the stale installations in view, or the selected ones, only after
 * a person has approved each one as it would actually be installed: the MCP
 * `marketplace_update` apply (DOR-2195).
 *
 * Unlike {@link applyInstalledUpdates}, which authorizes before any network
 * work, this checks first and stages every stale installation's new version,
 * so the gate is asked about exactly the installations that would change, with
 * their versions and everything the new version would run. Nothing stale means
 * nothing to ask. After a yes, each approved installation is reinstalled held
 * to the disclosure the person saw: the installer refuses one whose new version
 * now declares something else, before removing anything.
 *
 * @param deps - The server's update dependencies.
 * @param req - The requested project and the selection.
 * @param gate - The surface's way of asking a person.
 * @returns The refusal, or the per-installation result.
 * @throws {PackageNotInstalledForUpdateError} When a selected name or path is
 *   not in view, before anything is checked.
 */
export async function applyApprovedUpdates<R>(
  deps: InstalledUpdatesDeps,
  req: RequestedProject & InstallationSelector,
  gate: ApprovalGate<R>
): Promise<{ refused: R } | { result: InstallationUpdatesResult }> {
  const installations = selectInstallations(await scanUpdateView(deps, req.projectPath), req);
  const plan = await deps.updateFlow.planInstallations({ installations, disclose: true });

  const updates: ApprovableUpdate[] = plan.checks
    .filter((c) => c.status === 'update-available' && c.disclosed !== undefined)
    .map((c) => {
      const projectPath = callerSpelling(c.agentPath, req);
      return {
        packageName: c.packageName,
        installPath: c.installPath,
        type: c.type,
        scope: c.scope,
        ...(projectPath !== undefined && { projectPath }),
        ...(c.agentName !== undefined && { agentName: c.agentName }),
        installedVersion: c.installedVersion,
        latestVersion: c.latestVersion,
        disclosed: c.disclosed ?? null,
      };
    });
  if (updates.length === 0) return { result: { checks: plan.checks } };

  const refused = await gate(updates);
  if (refused !== undefined) return { refused };

  const result = await deps.updateFlow.applyPlan(
    plan,
    new Map(updates.map((u) => [u.installPath, u.disclosed]))
  );
  notifyApplied(deps, result, req);
  return { result };
}
