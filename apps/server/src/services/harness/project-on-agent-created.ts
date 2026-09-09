/**
 * Pointing a DorkOS agent at a project sets that project up for the agent tool
 * DorkOS runs there (contract TR-11 / J-03, DOR-1901).
 *
 * ## The gap this closes
 *
 * A person points a DorkOS agent at a repository they already work in — one
 * that has an `AGENTS.md` and has only ever run OpenCode, say. Nothing
 * happened. `runAutoProjection` fires when a marketplace package changes, the
 * boot pass covers agent HOMES under `<dorkHome>/agents`, and the
 * `.agents/skills` watcher refuses to set up a project that has never synced.
 * None of those is "somebody just asked DorkOS to work here". So the repository
 * got no manifest, no `.claude/CLAUDE.md`, and the managed Claude Code session
 * DorkOS then started there had never seen the house rules the person keeps in
 * their own `AGENTS.md`.
 *
 * This is that trigger. It fires once per created or registered agent, from the
 * one seam every arrival goes through (`services/core/agent-created-hook.ts`),
 * and it is the same shape `runAutoProjection` has — the consent seam, under the
 * project lock — with three deliberate differences.
 *
 * ## What it does, and does not, do
 *
 * - **It scaffolds.** A repository with no manifest gets one, with the harness
 *   DorkOS's own runtime reads added to whatever detection found
 *   (`scaffoldManifest`'s `dorkosHarness`). This is one of only two paths
 *   allowed to write a manifest into a project unprompted — the other is
 *   `dorkos harness sync --fix` — and it is allowed for the same reason: a
 *   person just asked DorkOS to work here. DOR-678's rule is about `--check`,
 *   which reports and must never write; this is not that.
 * - **It never sweeps.** `sweepOrphans` deletes what the current plan does not
 *   name, and a trigger firing off somebody's action runs against a tree they
 *   may be halfway through editing (contract D5). Additive only; `dorkos harness
 *   sync --fix` is the surface that prunes.
 * - **It asks nobody.** An approval card raised by "I made an agent" is a card
 *   at the wrong moment, and people learn to dismiss those. A package's hooks
 *   stay withheld and are COUNTED in the log line; the marketplace install path
 *   is where the card belongs.
 *
 * ## Where it refuses
 *
 * - **An agent HOME.** `<dorkHome>/agents/*` is DorkOS's own tree, already
 *   projected by `agent-creator` at creation and by the boot backfill after —
 *   with a Claude-Code-only manifest, on purpose (`project-agent-workspace.ts`).
 *   Projecting it again here would write a different harness set into the same
 *   folder.
 * - **Outside the boundary.** A projection writes real files, and the path on a
 *   registration request is whatever the caller sent. It is validated at the
 *   route, and judged again here, because this seam has four callers and one of
 *   them is a mesh discovery scan that never went near a route.
 *   `validateBoundaryOrDorkHome`, so a `DORKOS_BOUNDARY`-scoped deployment does
 *   not refuse the homes — which are then refused a line above, for a better
 *   reason.
 * - **With `harness.autoSync` off.** The person manages projection themselves.
 *
 * All three are settled BEFORE the lock is taken, so a no-op never queues behind
 * somebody else's projection.
 *
 * Best-effort throughout: every failure is caught and logged. A created agent
 * must never fail because a projection did, and the seam that calls this
 * swallows what it throws anyway — catching here is what lets the log line name
 * the repository.
 *
 * @module services/harness/project-on-agent-created
 */
import {
  dorkosHarnessScaffoldNotice,
  scaffoldManifest as defaultScaffoldManifest,
  HARNESS_MANIFEST_PATH,
} from '@dorkos/harness';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateBoundaryOrDorkHome } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { configManager } from '../core/config-manager.js';
import { dorkosHarness } from './dorkos-harness.js';
import { isAgentHome } from './project-agent-workspace.js';
import {
  projectWithConsent as defaultProjectWithConsent,
  withProjectLock,
} from './project-with-consent.js';

/** The just-created or just-registered agent, as this trigger reads it. */
export interface ProjectedAgent {
  /** The agent's slug, for the log lines. */
  name: string;
  /** The directory the agent works in — the repository this trigger is about. */
  path: string;
}

/** Options for {@link runAgentCreatedProjection}. */
export interface RunAgentCreatedProjectionOptions {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
}

/**
 * Seam for the calls this trigger makes, injectable so a test can exercise the
 * refusals and the ordering without touching a real tree.
 *
 * Three entries, the same two the install trigger has plus the boundary: the
 * consent-carrying projection, the manifest scaffold, and the question of
 * whether DorkOS may write here at all.
 *
 * @internal Exported for testing only.
 */
export const _internal = {
  scaffoldManifest: defaultScaffoldManifest,
  projectWithConsent: defaultProjectWithConsent,
  withinBoundary: defaultWithinBoundary,
};

/**
 * Whether DorkOS may write into a directory, by the server's own boundary rule.
 *
 * Any throw is a refusal, including the one an uninitialized boundary raises: a
 * projection writes files, and the safe reading of "I could not tell" is no.
 *
 * @param path - The project root to judge.
 * @returns True when a projection may write there.
 */
async function defaultWithinBoundary(path: string): Promise<boolean> {
  try {
    await validateBoundaryOrDorkHome(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set up the repository an agent was just pointed at, once.
 *
 * @param agent - The agent that was created or registered.
 * @param opts - Resolved dork home.
 */
export async function runAgentCreatedProjection(
  agent: ProjectedAgent,
  opts: RunAgentCreatedProjectionOptions
): Promise<void> {
  const { name, path } = agent;

  // DorkOS's own agent homes are somebody else's job — `agent-creator` projects
  // one at creation and the boot backfill keeps it current, both with the
  // Claude-Code-only manifest an agent workspace is supposed to have.
  if (isAgentHome(path, opts.dorkHome)) {
    logger.debug('[HarnessSync] Agent home already projected by its own pass; not projecting', {
      agent: name,
      path,
    });
    return;
  }

  if (!configManager.get('harness').autoSync) {
    logger.debug('[HarnessSync] Auto-projection disabled (harness.autoSync=false)', {
      agent: name,
      path,
    });
    return;
  }

  if (!(await _internal.withinBoundary(path))) {
    logger.debug('[HarnessSync] Refusing to project outside the directory boundary', {
      agent: name,
      path,
    });
    return;
  }

  try {
    await withProjectLock(path, () => projectForAgent(agent, opts.dorkHome));
  } catch (err) {
    logger.warn('[HarnessSync] Projecting a new agent’s project failed (non-fatal)', {
      agent: name,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scaffold if needed, then project — the whole of the work, inside the lock.
 *
 * Split out so the lock covers the scaffold as well as the projection: a second
 * writer that scaffolded between the two would leave this one planning from a
 * manifest it never read.
 *
 * @param agent - The agent that was created or registered.
 * @param dorkHome - Resolved DorkOS data directory.
 */
function projectForAgent(agent: ProjectedAgent, dorkHome: string): void {
  const { name, path } = agent;
  const ours = dorkosHarness();

  if (!existsSync(join(path, HARNESS_MANIFEST_PATH))) {
    const scaffold = _internal.scaffoldManifest(path, {
      ...(ours === undefined ? {} : { dorkosHarness: ours }),
    });
    if (scaffold.created) {
      logger.info('[HarnessSync] Scaffolded harness manifest for a new agent’s project', {
        agent: name,
        path,
        harnesses: scaffold.harnesses,
      });
      // The one entry in that set a person could not have predicted from their
      // own folder, said as one plain line — the same sentence the CLI and the
      // install trigger print, from the same function.
      if (scaffold.addedForDorkos) {
        logger.info(`[HarnessSync] ${dorkosHarnessScaffoldNotice(scaffold.addedForDorkos)}`, {
          path,
        });
      }
    }
    // `project()` reads the manifest with a bare `readFileSync`, so a missing one
    // surfaces as an unhelpful ENOENT. If the scaffold did not land (a read-only
    // directory, a race that removed it), bail out cleanly instead.
    if (!existsSync(join(path, HARNESS_MANIFEST_PATH))) {
      logger.debug('[HarnessSync] No harness manifest after scaffold; skipping projection', {
        agent: name,
        path,
      });
      return;
    }
  }

  const { applied, conflicts, swept, withheld, leftAlone } = _internal.projectWithConsent(path, {
    dorkHome,
    // A trigger never sweeps (contract D5): this runs off somebody's action on a
    // tree they may be mid-edit in, and the sweep deletes what the plan does not
    // name.
    sweepOrphans: false,
    ...(ours === undefined ? {} : { dorkosHarness: ours }),
  });

  if (conflicts.length > 0) {
    logger.warn('[HarnessSync] Projection for a new agent’s project blocked by conflicts', {
      agent: name,
      path,
      conflicts: conflicts.length,
    });
  }

  logger.info('[HarnessSync] Projected the project a new agent was pointed at', {
    agent: name,
    path,
    applied: applied.length,
    conflicts: conflicts.length,
    // Never asked about here, only counted: see the module docs.
    hooksWithheld: withheld.length,
    leftAlone: leftAlone.length,
    // Always zero — this trigger does not sweep. Reported so a log line that
    // ever showed a number would be the sweep coming back by accident.
    swept: swept.length,
  });
}
