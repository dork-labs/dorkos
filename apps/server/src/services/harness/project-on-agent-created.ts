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
 * ## Which arrivals fire it
 *
 * **Every arrival except the one that already has a projector.** The create
 * PIPELINE (`createAgentWorkspace`) projects the workspace it just built, and
 * it says so on the arrival: `workspaceProjectedByPipeline`. That flag is the
 * only thing this trigger skips on.
 *
 * It is a flag rather than a reading of `origin`, and the difference is a whole
 * journey. `origin: 'created'` is true of the pipeline AND of
 * `POST /api/agents`, which is not the pipeline at all — it mints a manifest at
 * a path a person named and scaffolds nothing else — so a person pointing an
 * agent at a repository they already work in arrives as `'created'` and is
 * exactly the journey this trigger exists for (contract J-03). Skipping on the
 * origin string would skip them; skipping on the fact skips only the pipeline.
 *
 * And the pipeline has to be skipped, because it is a race that was measured.
 * It notifies this seam BEFORE it runs its own `projectAgentWorkspace`, and that
 * pass deliberately scaffolds `AGENT_WORKSPACE_HARNESSES` — Claude Code alone,
 * with every package's hooks denied (contract HK-08). Both scaffolds are
 * write-if-absent, so whichever lands first wins, and this one is first. By then
 * the pipeline has already written `AGENTS.md`, `.claude/CLAUDE.md`, `GEMINI.md`
 * and `.github/copilot-instructions.md` into the workspace, so DETECTION reads
 * DorkOS's own scaffolds as four harnesses somebody uses: measured on a real
 * server against a directory override, the manifest came out
 * `["claude-code","codex","gemini","copilot","opencode"]`. A codex-enabled
 * manifest is exactly what turns an unattended pass into a writer of shell
 * commands — with a hook in that workspace's `.claude/settings.json` DorkOS
 * generated a `.codex/hooks.json` for it, which is the hazard
 * `project-agent-workspace.ts`'s module docs exist to name.
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
 * All four are settled BEFORE the lock is taken, so a no-op never queues behind
 * somebody else's projection.
 *
 * ## The one arrival that is not a person's action
 *
 * Four call sites notify this seam and three of them are unambiguously somebody
 * asking: the create pipeline, `POST /api/agents`, and `POST /api/mesh/agents`.
 * The fourth is `MeshCore.onAgentAdopted` — a discovery scan walking past a
 * `.dork/agent.json` this machine had never registered — and that scan is run
 * BOTH by a person (`POST /api/discovery/scan`, the `mesh_discover` tool) and,
 * every five minutes, by the mesh reconciler rebuilding the registry from files
 * (ADR-0043, `reconciler.ts`'s step 5). The reconciler half is DorkOS catching
 * up on its own records, which is precisely the case
 * `backfillAgentWorkspaceSkills` refuses to write for: booting asks for nothing.
 *
 * It is not refused here, and that is a decision rather than an oversight.
 * `CreatedAgentInfo.origin` cannot tell the two apart — the mesh REGISTER route
 * and the scan both declare `'registered'`, and the register route is the very
 * journey this trigger exists for (contract J-03) — so refusing the reconciler
 * would mean either a third `origin` value, a contract change to a hook two
 * other reactions read, or moving this call out to three call sites, which is
 * the exact drift the seam exists to prevent. What the reconciler can reach is
 * bounded and stated: it fires only on the pass that FIRST registers an id, so
 * at most once per agent ever; it is refused outside the boundary and inside
 * `<dorkHome>/agents`; it only ever ADDS files (no sweep, no hooks); and
 * `harness.autoSync` turns the whole thing off. Telling the two scans apart is
 * the follow-up.
 *
 * Best-effort throughout: every failure is caught and logged. A created agent
 * must never fail because a projection did, and the seam that calls this
 * swallows what it throws anyway — catching here is what lets the log line name
 * the repository.
 *
 * @module services/harness/project-on-agent-created
 */
import {
  agentsMdExists,
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
  /**
   * Set only by the create pipeline, which projects this workspace itself a few
   * lines after it notifies. The one thing this trigger stands down for — see
   * "Which arrivals fire it" above for the race that decides it.
   */
  workspaceProjectedByPipeline?: boolean;
}

/** Options for {@link runAgentCreatedProjection}. */
export interface RunAgentCreatedProjectionOptions {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
}

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

  // A workspace the create pipeline built already has a projector, and this
  // trigger would beat it to the manifest — see "Which arrivals fire it".
  if (agent.workspaceProjectedByPipeline === true) {
    logger.debug('[HarnessSync] The create pipeline projects this workspace; not projecting', {
      agent: name,
      path,
    });
    return;
  }

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
        logger.info(
          `[HarnessSync] ${dorkosHarnessScaffoldNotice(scaffold.addedForDorkos, agentsMdExists(path))}`,
          {
            path,
          }
        );
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
