/**
 * Auto-projection on marketplace plugin install/uninstall (GAP-4).
 *
 * When a marketplace plugin is installed or uninstalled into a project, the
 * Claude SDK plugin cache is refreshed in `index.ts`. This service is the
 * additional, runtime-neutral half: it projects the plugin's portable assets
 * (skills, hooks) to the project's *other* harnesses (Codex, etc.) via the
 * Harness Sync engine, so a single install reaches every agent the project uses.
 *
 * The wiring is intentionally narrow in v1:
 *
 * - **Project-scoped only.** A global install (`projectPath` absent) is a
 *   deliberate no-op — cross-agent projection of global installs is deferred
 *   (DOR-143 / DOR-174). The engine's project sync only ever projects a repo's
 *   own `.dork/plugins`, so there is nothing to do without a project root.
 * - **Config-gated.** Honors the `harness.autoSync` flag (default `true`). When
 *   off, the user manages projection manually via `dorkos harness sync`.
 * - **Hook-gated.** A package's hooks are shell commands the harnesses run
 *   unattended, so they only project once a person has allowed those exact
 *   commands (DOR-522). Everything else about the package — skills, commands —
 *   projects as it always did. See `hook-approval.ts` for where the gate sits and
 *   why it is not on the install itself.
 * - **Best-effort.** Every failure is caught and logged as a warning; this
 *   service never throws into the request path, mirroring the existing
 *   `refreshActivatedPlugins().catch(...)` pattern.
 *
 * Both install and uninstall run the same project + apply: install *adds* the
 * new plugin's projections, uninstall *prunes* the now-orphaned ones via the
 * engine's orphan sweep (`sweepOrphans`, the GAP-8 behavior). The plan is
 * derived from the filesystem after the install/uninstall has already mutated
 * `<projectPath>/.dork/plugins`, so the same code path is correct for both
 * actions.
 *
 * Concurrency: this runs fire-and-forget from the install route, so two
 * project-scoped installs into the SAME repo can overlap inside `applyPlan`.
 * The engine's apply is idempotent and write-if-absent, so concurrent applies
 * converge rather than corrupt, but they are serialized only by chance, not by
 * a lock. If overlapping installs into one repo become a real workflow, add a
 * per-`projectPath` mutex here.
 *
 * @module services/harness/auto-project
 */
import {
  applyPlan as defaultApplyPlan,
  project as defaultProject,
  projectedHookCommands as defaultProjectedHookCommands,
  scanInstalledPlugins as defaultScanInstalledPlugins,
  scaffoldManifest as defaultScaffoldManifest,
  HARNESS_MANIFEST_PATH,
} from '@dorkos/harness';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configManager } from '../core/config-manager.js';
import { logger } from '../../lib/logger.js';
import {
  askForHookProjection,
  isHookProjectionApproved,
  recordHookApproval,
  type HookApprovalGateway,
  type HookProjectionRequest,
} from './hook-approval.js';

/** The install action that triggered auto-projection. */
export type PluginChangeAction = 'install' | 'uninstall';

/** Context describing the plugin change that may trigger auto-projection. */
export interface PluginChangeContext {
  /**
   * The project root the plugin was installed into. Absent for a global
   * install, which is a deliberate no-op (see module docs).
   */
  projectPath?: string;
  /** The marketplace package name that changed. */
  packageName: string;
  /** Whether the change was an install or an uninstall. */
  action: PluginChangeAction;
}

/** Options for {@link runAutoProjection}. */
export interface RunAutoProjectionOptions {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /**
   * The approval primitive, used to ask before a package's hooks are installed.
   *
   * Optional because a boot without it must still project skills and commands —
   * but its absence FAILS CLOSED: with nobody to ask, hooks a person has not
   * already allowed simply do not project.
   */
  approvals?: HookApprovalGateway;
}

/**
 * Seam for the Harness Sync engine calls, injectable so route/service tests can
 * exercise the gating logic without touching the real filesystem or git. The
 * defaults are the real `@dorkos/harness` exports.
 *
 * @internal Exported for testing only.
 */
export const _internal = {
  scaffoldManifest: defaultScaffoldManifest,
  project: defaultProject,
  applyPlan: defaultApplyPlan,
  scanInstalledPlugins: defaultScanInstalledPlugins,
  projectedHookCommands: defaultProjectedHookCommands,
};

/**
 * Every hook-declaring package in the project, split by whether a person has
 * already allowed the exact commands it wants to install.
 *
 * Scanning the plugins here rather than reading them back off the plan is
 * deliberate: the Claude Code settings merge is the only place the plan names
 * packages individually, and it is absent when a project does not sync to Claude
 * Code — yet those projects still get the same commands in their generated Codex
 * hooks file. The question is about packages, so it is asked of the packages.
 *
 * @param projectPath - The project root being projected into.
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns The allowed package names, and the pending requests to ask about.
 */
function partitionHookRequests(
  projectPath: string,
  dorkHome: string
): { allowed: Set<string>; pending: HookProjectionRequest[] } {
  const plugins = _internal.scanInstalledPlugins({ dorkHome, projectRoot: projectPath });
  const allowed = new Set<string>();
  const pending: HookProjectionRequest[] = [];
  for (const { packageName, commands } of _internal.projectedHookCommands(plugins, projectPath)) {
    const request: HookProjectionRequest = { projectPath, packageName, commands };
    if (isHookProjectionApproved(request)) allowed.add(packageName);
    else pending.push(request);
  }
  return { allowed, pending };
}

/**
 * Build the plan and realize it, logging what landed.
 *
 * Runs once for a package with no hooks to ask about, and a second time after a
 * person allows some — the engine's apply is idempotent and write-if-absent, so
 * the second pass adds the newly allowed hooks and rewrites everything else to
 * the same bytes.
 *
 * @param ctx - The plugin change that triggered this (for the log lines).
 * @param dorkHome - Resolved DorkOS data directory.
 * @param allowedHookPackages - Packages whose hooks a person has allowed.
 */
function projectOnce(
  ctx: PluginChangeContext & { projectPath: string },
  dorkHome: string,
  allowedHookPackages: ReadonlySet<string>
): void {
  const { projectPath, packageName, action } = ctx;
  const plan = _internal.project(projectPath, {
    dorkHome,
    allowPluginHooks: (name) => allowedHookPackages.has(name),
  });
  // `sweepOrphans` prunes projections for plugins no longer in the plan — the
  // uninstall path. The plan here is the full (unfiltered) project plan, which
  // is the precondition the sweep requires. Install adds; uninstall prunes.
  const { applied, conflicts, swept } = _internal.applyPlan(projectPath, plan, {
    sweepOrphans: true,
  });

  // An install whose package contributes NOTHING to the plan means the
  // plugin's files never reach any harness — the exact silent failure of
  // DOR-264. Surface it loudly instead of burying an `applied: 0` in the
  // info summary. (Legitimate for asset-free packages, hence warn not error.)
  const pluginPrefix = `.dork/plugins/${packageName}/`;
  const touchesPackage = (entry: { source?: string }): boolean =>
    entry.source?.startsWith(pluginPrefix) ?? false;
  if (
    action === 'install' &&
    !plan.actions.some(touchesPackage) &&
    !plan.drops.some(touchesPackage)
  ) {
    logger.warn('[HarnessSync] Install projected no files for package', {
      packageName,
      projectPath,
      hint: `Nothing under ${pluginPrefix} contributed skills, commands, or hooks to any harness. The package may have no portable assets, or its install directory was not recognized.`,
    });
  }

  // A conflict means a real file is blocking a managed projection target;
  // surface it at warn rather than burying it in the info-level summary.
  if (conflicts.length > 0) {
    logger.warn('[HarnessSync] Auto-projection blocked by conflicts', {
      packageName,
      action,
      projectPath,
      conflicts: conflicts.length,
    });
  }

  logger.info('[HarnessSync] Auto-projection complete', {
    packageName,
    action,
    projectPath,
    applied: applied.length,
    conflicts: conflicts.length,
    swept: swept.length,
  });
}

/**
 * Project a just-changed plugin's portable assets to the project's other
 * harnesses, gated on install scope and the `harness.autoSync` config flag.
 *
 * No-op (with a debug log) when:
 *
 * - the install was global (`ctx.projectPath` is absent) — deferred, see module docs;
 * - `harness.autoSync` is `false` — the user manages projection manually.
 *
 * Otherwise, for a project-scoped install with auto-sync on: scaffold the
 * harness manifest if the project has none (GAP-5), build the projection plan
 * from disk, and apply it with the orphan sweep enabled so an uninstall prunes
 * the now-orphaned projections (GAP-8). Any failure is caught and logged as a
 * warning; this function never throws.
 *
 * Hooks are the exception to "project everything on disk". A package whose exact
 * commands nobody has allowed contributes no hooks to that first pass; the person
 * is asked, and a yes records the decision and projects a second time (DOR-522).
 * The returned promise therefore stays unresolved while an approval is pending,
 * which is why the install route treats this as fire-and-forget.
 *
 * @param ctx - the plugin change that occurred (scope, package name, action).
 * @param opts - resolved dork home, forwarded to the engine for global-scope
 *   reads, and the approval service used to ask about hooks.
 */
export async function runAutoProjection(
  ctx: PluginChangeContext,
  opts: RunAutoProjectionOptions
): Promise<void> {
  const { projectPath, packageName, action } = ctx;

  // Global installs are a deliberate no-op in v1: cross-agent projection of
  // global installs is deferred (DOR-143 / DOR-174).
  if (!projectPath) {
    logger.debug('[HarnessSync] Skipping auto-projection for global plugin change', {
      packageName,
      action,
    });
    return;
  }

  if (!configManager.get('harness').autoSync) {
    logger.debug('[HarnessSync] Auto-projection disabled (harness.autoSync=false)', {
      packageName,
      action,
      projectPath,
    });
    return;
  }

  try {
    // GAP-5: a project with no harness manifest gets a scaffolded default so the
    // engine has something to project instead of no-opping. Write-if-absent, so
    // a hand-authored manifest is left untouched.
    if (!existsSync(join(projectPath, HARNESS_MANIFEST_PATH))) {
      const scaffold = _internal.scaffoldManifest(projectPath);
      if (scaffold.created) {
        logger.info('[HarnessSync] Scaffolded harness manifest for project', {
          projectPath,
          harnesses: scaffold.harnesses,
        });
      }
      // If a manifest still does not exist (scaffold failed, or a race removed
      // it), `project()` -> `loadManifest()` would throw ENOENT and surface as a
      // noisy "projection failed". Bail out explicitly with a debug log instead.
      if (!existsSync(join(projectPath, HARNESS_MANIFEST_PATH))) {
        logger.debug('[HarnessSync] No harness manifest after scaffold; skipping projection', {
          projectPath,
          packageName,
          action,
        });
        return;
      }
    }

    // Hooks are the one part of a package that runs code, so they project only
    // for packages a person has allowed (DOR-522). Everything else projects
    // whatever the answer is.
    const { allowed, pending } = partitionHookRequests(projectPath, opts.dorkHome);
    projectOnce({ ...ctx, projectPath }, opts.dorkHome, allowed);

    if (pending.length === 0) return;
    if (!opts.approvals) {
      logger.warn('[HarnessSync] No approval service; package hooks were not projected', {
        packageName,
        projectPath,
        packages: pending.map((p) => p.packageName),
      });
      return;
    }

    // One card per package, all raised before any is awaited, so a person sees
    // everything that is waiting instead of one card at a time.
    const gateway = opts.approvals;
    const decisions = await Promise.all(
      pending.map(async (request) => ({
        request,
        granted: await askForHookProjection(gateway, request),
      }))
    );
    const granted = decisions.filter((d) => d.granted).map((d) => d.request);
    if (granted.length === 0) return;

    // Record first, then re-project: the record is what stops the next
    // projection asking again, and it must survive a failure in the apply.
    for (const request of granted) {
      recordHookApproval(request);
      allowed.add(request.packageName);
    }
    projectOnce({ ...ctx, projectPath }, opts.dorkHome, allowed);
  } catch (err) {
    logger.warn('[HarnessSync] Auto-projection failed (non-fatal)', {
      packageName,
      action,
      projectPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
