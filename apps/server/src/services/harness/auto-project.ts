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
  scaffoldManifest as defaultScaffoldManifest,
  HARNESS_MANIFEST_PATH,
} from '@dorkos/harness';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configManager } from '../core/config-manager.js';
import { logger } from '../../lib/logger.js';

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
};

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
 * @param ctx - the plugin change that occurred (scope, package name, action).
 * @param opts - resolved dork home, forwarded to the engine for global-scope reads.
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

    const plan = _internal.project(projectPath, { dorkHome: opts.dorkHome });
    // `sweepOrphans` prunes projections for plugins no longer in the plan — the
    // uninstall path. The plan here is the full (unfiltered) project plan, which
    // is the precondition the sweep requires. Install adds; uninstall prunes.
    const { applied, conflicts, swept } = _internal.applyPlan(projectPath, plan, {
      sweepOrphans: true,
    });

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
  } catch (err) {
    logger.warn('[HarnessSync] Auto-projection failed (non-fatal)', {
      packageName,
      action,
      projectPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
