/**
 * Project an agent workspace's own `.agents/` assets to its harnesses (DOR-659).
 *
 * DorkOS seeds the Operating DorkOS skill pack into every agent workspace at
 * `<agentDir>/.agents/skills/` (`@dorkos/operating-skills`). Codex and OpenCode
 * read that directory natively, but Claude Code — the DEFAULT runtime — does
 * not: it only sees skills under `.claude/skills/`. Without a projection pass
 * the whole self-use skill pack is invisible to the runtime most agents run on,
 * including DorkBot's.
 *
 * The Harness Sync engine already knows how to bridge that gap (a relative
 * symlink per skill, `plan/projector.ts`); nothing was calling it on an agent
 * workspace. This module is that call — the *only* new code path, deliberately:
 * it owns no symlink logic of its own.
 *
 * Four properties matter here:
 *
 * - **Best-effort.** A projection failure must never block agent creation or
 *   server boot, so every failure is caught and logged. This is also what makes
 *   the pass safe on Windows, where symlink creation can fail with `EPERM`
 *   without Developer Mode and the engine has no catch of its own.
 * - **Claude Code only, which is why no hooks are generated.** A scaffolded
 *   agent workspace enables ONLY claude-code ({@link AGENT_WORKSPACE_HARNESSES}).
 *   That is the honest scope: Codex and OpenCode read `.agents/skills/` natively
 *   and need no projection at all, so enabling them would buy nothing — and it
 *   would cost something real. `project()` merges the workspace's own
 *   `.claude/settings.json` hooks (`loadClaudeHooks`, unconditional) with every
 *   installed package's hooks and generates a `.codex/hooks.json` from them, so
 *   a codex-enabled manifest turns this unattended pass into a writer of shell
 *   commands. Claude Code already reads its own settings, so with only
 *   claude-code enabled there is no hooks file to generate anywhere.
 *   `allowPluginHooks` is denied as well, which covers the case where somebody
 *   hand-authors a manifest enabling another harness: their choice of harness is
 *   respected (same as `dorkos harness sync`), but a marketplace package still
 *   cannot slip shell commands in without the approval `hook-approval.ts`
 *   requires (DOR-522). Note `<agentDir>/.dork/plugins` is scanned regardless of
 *   `dorkHome`, so omitting the home is NOT what keeps package hooks out.
 * - **Narrow.** No `dorkHome` is passed to `project()`, so globally installed
 *   marketplace plugins are not projected into every agent's home — only the
 *   workspace's own `.agents/` assets and its own `.dork/plugins`. Cross-agent
 *   projection of global installs is a separate decision (DOR-143 / DOR-174).
 * - **No orphan sweep.** `sweepOrphans` runs five sweeps, not one: it prunes
 *   installed-plugin symlinks, generated hook files, generated command wrappers,
 *   OpenCode commands, and the managed block in `.claude/settings.local.json`.
 *   Those all delete files, and this pass runs unattended in a directory a
 *   person may also be editing by hand, so it stays additive. The visible cost
 *   is that a projection this pass made is never withdrawn by it; `dorkos
 *   harness sync --fix` is the surface that prunes.
 *
 * @module services/harness/project-agent-workspace
 */
import { applyPlan, project, scaffoldManifest, HARNESS_MANIFEST_PATH } from '@dorkos/harness';
import type { HarnessId } from '@dorkos/harness';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { logger } from '../../lib/logger.js';

/** Workspace-relative directory holding an agent's canonical skills. */
const AGENT_SKILLS_DIR = join('.agents', 'skills');

/**
 * The harness set DorkOS scaffolds into an agent workspace it owns.
 *
 * Only Claude Code, because only Claude Code needs anything projected: the other
 * harnesses read `.agents/skills/` natively. Enabling more would add no skill
 * coverage and would make this unattended pass generate hook files. See the
 * module docs.
 */
const AGENT_WORKSPACE_HARNESSES: readonly HarnessId[] = ['claude-code'];

/**
 * No installed package may contribute hooks to an agent-workspace projection.
 *
 * Hooks are shell commands the harnesses run on the person's behalf, and this
 * pass runs unattended — at agent creation and at server boot — with nobody to
 * ask. See the module docs.
 */
const DENY_ALL_PLUGIN_HOOKS = (): boolean => false;

/**
 * Resolve a path through symlinks when it exists, else normalize it lexically.
 *
 * Containment has to be decided on the same kind of path on both sides. A dork
 * home reached through a symlink, or handed over as a relative `DORK_HOME`
 * (`resolveDorkHome` returns the env var verbatim), otherwise compares unequal
 * to the very workspace it contains — and the repair silently does nothing.
 *
 * @param p - Path to canonicalize.
 * @returns The real path, or the lexically resolved one when it does not exist.
 */
function canonicalize(p: string): string {
  const absolute = resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Whether `dir` lives inside the agents directory this dork home owns
 * (`<dorkHome>/agents/`).
 *
 * Both sides are resolved through symlinks first, so a home reached by a
 * different route still matches — and, in the other direction, a symlink planted
 * inside the agents directory that points at somebody's repository does not.
 *
 * Deliberately scoped to `<dorkHome>/agents` and nothing else. It is tempting to
 * also accept `config.agents.defaultDirectory`, because in a DEV tree the two
 * diverge: `expandTilde()` expands that setting against the operator's real home
 * (`lib/boundary.ts`) while `dorkHome` is the tree-local `.temp/.dork`, so an
 * agent created from a dev server lands outside this boundary and is not
 * repaired. Do not widen it. That divergence is DOR-662 — a dev tree writing
 * into the real home is the bug, not the boundary — and unioning the two would
 * make a dev server's boot backfill write into the operator's real `~/.dork`,
 * which is the very escape DOR-662 exists to close. Fixing DOR-662 closes the
 * coverage gap here with no change to this function.
 *
 * @param dir - Absolute path to an agent workspace.
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns True when `dir` is a descendant of `<dorkHome>/agents`.
 */
function isInsideDorkHome(dir: string, dorkHome: string): boolean {
  const rel = relative(canonicalize(join(dorkHome, 'agents')), canonicalize(dir));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** What {@link projectAgentWorkspace} did with one workspace. */
export interface AgentWorkspaceProjection {
  /**
   * `projected` — the engine ran; `skipped` — there was nothing to project;
   * `failed` — the engine threw and the error was swallowed.
   */
  status: 'projected' | 'skipped' | 'failed';
  /** Projections realized on disk (symlinks, scaffolds, generated files). */
  applied: number;
  /** Targets left untouched because a real file or directory occupies them. */
  conflicts: number;
  /** Whether this run wrote the workspace's default harness manifest. */
  scaffoldedManifest: boolean;
}

/** Aggregate outcome of {@link backfillAgentWorkspaceProjections}. */
export interface AgentWorkspaceBackfillSummary {
  /** Workspaces considered. */
  total: number;
  /** Workspaces the engine ran against. */
  projected: number;
  /** Workspaces inside dork home with nothing to project. */
  skipped: number;
  /** Workspaces whose projection threw (already logged, non-fatal). */
  failed: number;
  /** Workspaces left alone because they are not DorkOS's to write into. */
  outsideDorkHome: number;
}

/**
 * Link an agent workspace's canonical skills into the layout each of its
 * harnesses reads, so a Claude Code session started in that workspace can
 * actually load them.
 *
 * No-ops when the workspace has no `.agents/skills/` directory. Otherwise it
 * scaffolds a Claude-Code-only `.agents/harness.manifest.json` when the
 * workspace has none (write-if-absent, so a hand-edited manifest is untouched
 * and its harness set is respected) and then runs the engine's plan + apply.
 *
 * Never throws — a failure is logged and reported in the returned status. The
 * warning names the workspace and the underlying error, because the failures
 * that reach it are usually actionable by a person: a hand-edited
 * `.claude/settings.json` with a trailing comma fails the engine's parse on
 * every boot, and the log line is the only place that says so.
 *
 * @param agentDir - Absolute path to the agent's workspace root.
 * @returns What happened, for the caller to log or assert on.
 */
export function projectAgentWorkspace(agentDir: string): AgentWorkspaceProjection {
  if (!existsSync(join(agentDir, AGENT_SKILLS_DIR))) {
    return { status: 'skipped', applied: 0, conflicts: 0, scaffoldedManifest: false };
  }

  let scaffoldedManifest = false;
  try {
    const manifestPath = join(agentDir, HARNESS_MANIFEST_PATH);
    if (!existsSync(manifestPath)) {
      scaffoldedManifest = scaffoldManifest(agentDir, {
        harnesses: AGENT_WORKSPACE_HARNESSES,
      }).created;
      // `project()` reads the manifest with a bare `readFileSync`, so a missing
      // one surfaces as an unhelpful ENOENT. If the scaffold did not land (a
      // read-only home, a race that removed it), bail out cleanly instead.
      if (!existsSync(manifestPath)) {
        logger.debug('[HarnessSync] No harness manifest after scaffold; skipping agent workspace', {
          agentDir,
        });
        return { status: 'skipped', applied: 0, conflicts: 0, scaffoldedManifest };
      }
    }

    const plan = project(agentDir, { allowPluginHooks: DENY_ALL_PLUGIN_HOOKS });
    const { applied, conflicts } = applyPlan(agentDir, plan);

    // A conflict means something real occupies a projection target, so that
    // skill stays invisible to the harness — worth surfacing, not burying.
    if (conflicts.length > 0) {
      logger.warn('[HarnessSync] Agent workspace projection blocked by conflicts', {
        agentDir,
        conflicts: conflicts.length,
      });
    }

    logger.debug('[HarnessSync] Projected agent workspace skills', {
      agentDir,
      applied: applied.length,
      conflicts: conflicts.length,
      scaffoldedManifest,
    });

    return {
      status: 'projected',
      applied: applied.length,
      conflicts: conflicts.length,
      scaffoldedManifest,
    };
  } catch (err) {
    logger.warn('[HarnessSync] Agent workspace projection failed (non-fatal)', {
      agentDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'failed', applied: 0, conflicts: 0, scaffoldedManifest };
  }
}

/**
 * Run {@link projectAgentWorkspace} over the agent workspaces DorkOS owns,
 * repairing the ones created before this projection existed.
 *
 * Only workspaces under `<dorkHome>/agents/` are touched. A registered agent can
 * point anywhere — a person's own git repository, a work checkout — and this pass
 * runs unprompted at boot. Writing a harness manifest and a `.claude/skills/`
 * tree into somebody's repository because a server started is a bigger action
 * than repairing DorkOS's own agent homes, so the boundary is drawn at the
 * directory `agent-creator` and `ensureDorkBot` create and where the seeded pack
 * lives.
 *
 * The asymmetry with the creation path is deliberate: creating an agent at a
 * path outside dork home DOES project there, because a person just asked DorkOS
 * to set that workspace up and the projection is part of what they asked for.
 * Booting asks for nothing. The honest cost is that an agent that already
 * existed outside dork home is not repaired here; it picks the projection up the
 * next time something writes to it.
 *
 * Idempotent (the engine's apply is write-if-absent and self-healing) and
 * best-effort per workspace, so one unreadable home never stops the rest. It
 * yields to the event loop between workspaces, which is what lets a caller fire
 * it off at boot without delaying anything else coming up.
 *
 * The single summary line is a WARNING when the pass had agents to repair and
 * repaired none of them, or when any workspace failed. A repair that quietly
 * does nothing on every boot is the worst outcome this function has, so it does
 * not get to hide at info level.
 *
 * @param workspaces - Absolute paths to every registered agent workspace.
 * @param dorkHome - Resolved DorkOS data directory (see `lib/dork-home.ts`).
 * @returns One summary of the whole pass, also logged as a single line.
 */
export async function backfillAgentWorkspaceProjections(
  workspaces: readonly string[],
  dorkHome: string
): Promise<AgentWorkspaceBackfillSummary> {
  const summary: AgentWorkspaceBackfillSummary = {
    total: workspaces.length,
    projected: 0,
    skipped: 0,
    failed: 0,
    outsideDorkHome: 0,
  };

  for (const agentDir of workspaces) {
    await yieldToEventLoop();
    if (!isInsideDorkHome(agentDir, dorkHome)) {
      summary.outsideDorkHome += 1;
      continue;
    }
    const { status } = projectAgentWorkspace(agentDir);
    if (status === 'projected') summary.projected += 1;
    else if (status === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
  }

  const repairedNothing = summary.total > 0 && summary.projected === 0;
  if (repairedNothing || summary.failed > 0) {
    logger.warn('[HarnessSync] Agent workspace skill projection backfill repaired nothing', {
      ...summary,
      hint: 'Registered agents were found but none had their skills linked. Run `dorkos harness sync --fix` in the agent workspace to see why.',
    });
  } else {
    logger.info('[HarnessSync] Agent workspace skill projection backfill complete', summary);
  }
  return summary;
}
