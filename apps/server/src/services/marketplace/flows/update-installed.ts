/**
 * The all-packages update door, independent of the surface that opens it.
 *
 * `GET` / `POST /api/marketplace/updates` and the marketplace MCP tools
 * (DOR-2195) share these steps: scan the installations in view once, narrow
 * them, check them saying what each new version would run
 * ({@link checkInstalledUpdates}), apply only after the surface's permission
 * step ({@link applyApprovedUpdates}), and send one `onPluginsChanged` per
 * reinstall that landed.
 *
 * Every apply checks first and stages each stale installation's new version,
 * so the permission step is asked about exactly the installations that would
 * change, with everything each new version would run, and each reinstall is
 * then held to it. Only the permission step is the surface's own: the MCP tool
 * raises an approval card; the HTTP route compares what the caller says it was
 * shown ({@link updatesNotAsShown}) and, for an agent, raises the same card
 * (DOR-2306).
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
import { sameDisclosedEffects, type DisclosedEffects } from '../disclosed-effects.js';
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
  updateFlow: Pick<UpdateFlow, 'planInstallations' | 'applyPlan'>;
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
 * The distinct `marketplace.install` inputs a set of reinstalls is authorized
 * with at the capability tier gate: one per package and scope, in the caller's
 * spelling of the scope. The HTTP apply asks the tier gate about each of these
 * before any network work, as the per-package route always did.
 *
 * @param records - The installations the apply covers.
 * @param requested - The project the request named, in both spellings.
 * @returns One input per distinct package and scope, in scan order.
 */
export function reinstallInputsFor(
  records: readonly InstallationRecord[],
  requested: RequestedProject
): ReinstallGateInput[] {
  const inputs = new Map<string, ReinstallGateInput>();
  for (const record of records) {
    const name = installationUpdateName(record);
    const projectPath = callerSpelling(record.package.agentPath, requested);
    const key = `${name}\n${projectPath ?? ''}`;
    if (!inputs.has(key))
      inputs.set(key, { name, ...(projectPath !== undefined && { projectPath }) });
  }
  return [...inputs.values()];
}

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
 * Check every installation in view, or the selected ones, and say what each
 * new version would run. Advisory: no installed package changes, though a
 * check may stage a newer version into the package cache.
 *
 * Every `update-available` check carries `disclosed`, read from the version a
 * reinstall would install, because that is what an apply is held to
 * (DOR-2306): a surface can only confirm an update by showing it and sending
 * it back. A new version whose declarations cannot be read is `unknown` with
 * the reason, so nothing unreadable is ever offered.
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
  const { checks } = await deps.updateFlow.planInstallations({ installations, disclose: true });
  return { checks };
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
 * `marketplace_update` apply (DOR-2195) and `POST /api/marketplace/updates`
 * (DOR-2306), the only two ways an update is applied.
 *
 * It checks first and stages every stale installation's new version, so the
 * gate is asked about exactly the installations that would change, with
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

/**
 * One installation as a caller says it was shown: the version a check offered
 * and what that version runs, sent back untouched.
 */
export interface ShownUpdate {
  /** The installation, as the check reported it. */
  installPath: string;
  /** The version the check offered. */
  latestVersion: string;
  /** What that version runs, as the check reported it. */
  disclosed: DisclosedEffects | null;
}

/**
 * The reinstalls an apply would make that differ from what the caller was
 * shown: another version, or a version that runs anything else, or an
 * installation it was never shown at all. Empty means every reinstall is
 * exactly what was shown.
 *
 * The comparison is {@link sameDisclosedEffects}, the canonicalization the
 * approval hash uses, so "the same disclosure" means one thing on every
 * surface.
 *
 * @param updates - The reinstalls, recomputed now.
 * @param shown - What the caller was shown, by installation.
 * @returns The reinstalls that are not as shown, in the order given.
 */
export function updatesNotAsShown(
  updates: readonly ApprovableUpdate[],
  shown: readonly ShownUpdate[]
): ApprovableUpdate[] {
  const byPath = new Map(shown.map((target) => [target.installPath, target]));
  return updates.filter((update) => {
    const target = byPath.get(update.installPath);
    return (
      target === undefined ||
      target.latestVersion !== update.latestVersion ||
      !sameDisclosedEffects(target.disclosed, update.disclosed)
    );
  });
}
