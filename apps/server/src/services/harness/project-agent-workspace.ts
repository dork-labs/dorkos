/**
 * Give every agent workspace DorkOS owns the current Operating DorkOS skill pack,
 * in the layout its harness reads (DOR-659, DOR-671).
 *
 * Two halves, and an agent needs both to be able to use a skill:
 *
 * 1. **Seed** — write the pack into `<agentDir>/.agents/skills/`
 *    (`seedOperatingSkills`, `@dorkos/operating-skills`). Idempotent and
 *    version-stamped: absent files are written, DorkOS's own unmodified older
 *    copies are rewritten, and anything a person edited or authored is left
 *    alone.
 * 2. **Project** — link `.agents/` into the layout each harness reads. Codex and
 *    OpenCode read `.agents/skills/` natively, but Claude Code — the DEFAULT
 *    runtime — only sees skills under `.claude/skills/`, so without this the
 *    whole self-use pack is invisible to the runtime most agents run on,
 *    including DorkBot's. The Harness Sync engine already knows how to bridge
 *    that gap (a relative symlink per skill, `plan/projector.ts`); nothing was
 *    calling it on an agent workspace. {@link projectAgentWorkspace} is that
 *    call — deliberately the *only* new code path: it owns no symlink logic of
 *    its own.
 *
 * **Seed before project, always.** {@link projectAgentWorkspace} returns early
 * when `.agents/skills/` does not exist. Run it first and a workspace that has
 * never been seeded is skipped before anything exists to link; seeding then
 * writes the pack, and the links do not appear until the NEXT boot. Same
 * one-boot lag for a newly added pack skill in an already-seeded workspace. The
 * order is the difference between "repaired" and "repaired next time", so it is
 * asserted by test rather than only written down here.
 *
 * The two halves are separate exports rather than one, because the third caller
 * cannot use them fused: `agent-creator` needs the `SeedResult` itself to note
 * created files on its rollback ledger, and deliberately runs the projection
 * OUTSIDE that ledger's protection (a symlink the ledger cannot remove would
 * survive a rollback and strand a half-built workspace). So
 * {@link backfillAgentWorkspaceSkills} and `ensureDorkBot` pair the halves,
 * `agent-creator` interleaves them with its own bookkeeping, and
 * {@link projectAgentWorkspace} stays exactly one thing.
 *
 * **Neither half is only for agent HOMES.** A room worktree is the other
 * directory a turn runs in, and Claude Code resolves its `project` setting
 * source against the cwd — so an agent working on a room's files sees the pack
 * only if the pack is in the worktree. `room-worktree-manager.ts` pairs the same
 * two exports there (DOR-1640); the reason they are usable for that is that
 * neither knows anything about mesh registration or dork home.
 *
 * Four properties matter for the projection half:
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
import { seedOperatingSkills } from '@dorkos/operating-skills';
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
 * Deliberately scoped to `<dorkHome>/agents` and nothing else. Since DOR-662
 * that is where DorkOS puts every agent it creates — production, dev, Docker and
 * tests alike — because the shipped `agents.defaultDirectory` is a portable
 * spelling of `{dorkHome}/agents` rather than a path to expand
 * (`lib/agents-home.ts`). Do not widen it to accept that setting blindly: a
 * person who points it somewhere of their own means somewhere of their own, and
 * those agents stay out of scope for an unprompted boot-time write (DOR-664).
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

/** Aggregate outcome of {@link backfillAgentWorkspaceSkills}. */
export interface AgentWorkspaceBackfillSummary {
  /** Workspaces considered. */
  total: number;
  /**
   * Workspaces where seeding wrote at least one skill file — a pack skill the
   * workspace never had, or DorkOS's own unmodified copy of an older one
   * rewritten at the current pack version. Zero on a steady-state boot, which
   * is the healthy reading: every owned workspace is already current.
   */
  seeded: number;
  /** Workspaces whose seeding threw (already logged, non-fatal). */
  seedFailed: number;
  /** Workspaces the projection engine ran against. */
  projected: number;
  /**
   * Workspaces that reached the projection with nothing to link.
   *
   * Nearly unreachable now that seeding runs first: seeding creates
   * `.agents/skills/`, and its existence is the only thing the projection
   * checks before bailing. What is left are the two shapes that fail without
   * throwing — seeding could not write at all, so the directory is still
   * absent (`seedFailed` is non-zero alongside it), or the harness manifest
   * scaffold did not land and {@link projectAgentWorkspace} bailed cleanly
   * rather than letting `project()` fail on an ENOENT. Kept for exactly that:
   * it is the honest way to say "this workspace ended the pass with nothing
   * linked, and the projection is not what went wrong".
   */
  skipped: number;
  /** Workspaces whose projection threw (already logged, non-fatal). */
  failed: number;
  /** Workspaces left alone because they are not DorkOS's to write into. */
  outsideDorkHome: number;
}

/** What seeding did to one workspace, collapsed to what the summary counts. */
export type SeedStatus = 'wrote' | 'unchanged' | 'failed';

/**
 * Seed the Operating DorkOS skill pack into one workspace, best-effort.
 *
 * Wraps `seedOperatingSkills` in the same swallow-and-log contract
 * {@link projectAgentWorkspace} keeps, for the same reason: this runs at boot,
 * and a workspace DorkOS cannot write into must not stop the ones it can, nor
 * stop this workspace's own projection from being attempted — a pack seeded on
 * an earlier boot still needs its links.
 *
 * Exported for the caller that is not an agent home: a room worktree is seeded
 * on the turn path, where a throw would cost the turn rather than a log line
 * (DOR-1640). Callers get the three-way status back and decide — the room
 * manager only re-projects when this says `wrote`, so a steady-state turn costs
 * nothing.
 *
 * @param agentDir - Absolute path to the workspace root to seed.
 * @returns `wrote` when at least one skill file was created or upgraded,
 *   `unchanged` when every skill was already current or is the person's own,
 *   `failed` when the seeder threw.
 */
export async function seedAgentWorkspace(agentDir: string): Promise<SeedStatus> {
  try {
    const { outcomes } = await seedOperatingSkills(agentDir);
    const created = outcomes.filter((o) => o.action === 'created').length;
    const upgraded = outcomes.filter((o) => o.action === 'upgraded').length;
    if (created + upgraded === 0) return 'unchanged';

    logger.debug('[HarnessSync] Seeded Operating DorkOS pack into agent workspace', {
      agentDir,
      created,
      upgraded,
      preserved: outcomes.filter((o) => o.action === 'preserved').length,
    });
    return 'wrote';
  } catch (err) {
    logger.warn('[HarnessSync] Agent workspace skill seeding failed (non-fatal)', {
      agentDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
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
 * Re-seed the Operating DorkOS skill pack into every agent workspace DorkOS
 * owns and link it where the harness reads it, so an agent created months ago
 * runs on the same pack as one created today.
 *
 * The gap this closes: `seedOperatingSkills` was called at agent creation and,
 * for DorkBot, on every boot — nowhere else. So a bump to
 * `OPERATING_SKILLS_VERSION` reached DorkBot and brand-new agents and no one
 * else, and every other agent kept the pack it was born with forever. That is
 * not cosmetic. Pack bumps have carried safety corrections: v4 retracted the
 * claim that `dorkos uninstall` was "the person's ungated path", and v6
 * retracted the claim that `tasks_delete` "carries no gate of its own", which
 * had agents deleting without warning anybody and reading a refusal as a
 * malfunction. An agent stuck on v3 is still being told both (DOR-671).
 *
 * Seeding runs BEFORE the projection for each workspace — see the module docs
 * for why the order is load-bearing rather than incidental.
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
 * Booting asks for nothing. The honest cost is that an agent living outside dork
 * home is never repaired by this pass; giving those a user-initiated repair is
 * DOR-664.
 *
 * Idempotent (the engine's apply is write-if-absent and self-healing) and
 * best-effort per workspace, so one unreadable home never stops the rest. It
 * yields to the event loop between workspaces, which is what lets a caller fire
 * it off at boot without delaying anything else coming up.
 *
 * The single summary line reports one of three outcomes, and says which:
 * repaired nothing (warn — the worst outcome this function has, so it does not
 * get to hide at info level), repaired some but not all (warn, naming both
 * counts), or clean (info). They are kept distinct because a line claiming a
 * total failure that did not happen sends whoever reads it hunting for the
 * wrong problem. "Repaired nothing" therefore weighs BOTH halves: a pass whose
 * seeding delivered a corrected pack to every workspace and whose projections
 * all failed did real work, and saying otherwise points the reader at the wrong
 * half of a two-half pass.
 *
 * @param workspaces - Absolute paths to every registered agent workspace.
 * @param dorkHome - Resolved DorkOS data directory (see `lib/dork-home.ts`).
 * @returns One summary of the whole pass, also logged as a single line.
 */
export async function backfillAgentWorkspaceSkills(
  workspaces: readonly string[],
  dorkHome: string
): Promise<AgentWorkspaceBackfillSummary> {
  const summary: AgentWorkspaceBackfillSummary = {
    total: workspaces.length,
    seeded: 0,
    seedFailed: 0,
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

    // Seed first, then project. Reversed, a skill written on this boot is not
    // linked until the next one, and a workspace with no `.agents/skills/` at
    // all gets nothing linked at all — the projection returns early on exactly
    // that check. See the module docs.
    const seedStatus = await seedAgentWorkspace(agentDir);
    if (seedStatus === 'wrote') summary.seeded += 1;
    else if (seedStatus === 'failed') summary.seedFailed += 1;

    const { status } = projectAgentWorkspace(agentDir);
    if (status === 'projected') summary.projected += 1;
    else if (status === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
  }

  const repairedSomething = summary.seeded > 0 || summary.projected > 0;
  const failures = summary.seedFailed + summary.failed;

  if (summary.total > 0 && !repairedSomething) {
    logger.warn('[HarnessSync] Agent workspace skill backfill repaired nothing', {
      ...summary,
      hint: 'Registered agents were found but none had their skills seeded or linked. Run `dorkos harness sync --fix` in the agent workspace to see why.',
    });
  } else if (failures > 0) {
    logger.warn('[HarnessSync] Agent workspace skill backfill partly failed', {
      ...summary,
      // The two counts are reported side by side, never one nested inside the
      // other. `seeded` and `projected` are independent: the corrupt-manifest,
      // unparseable-settings and Windows-EPERM cases all seed fine and fail to
      // link, which produces `seeded: 1, projected: 0` — and a phrasing like
      // "N linked, M of them newly seeded" then claims 1 of 0. This branch
      // exists so a log line does not send its reader after the wrong problem.
      hint: `Seeded ${summary.seeded} agent workspace(s), linked ${summary.projected}; ${summary.seedFailed} failed to seed and ${summary.failed} failed to link. Each failure was logged above with its workspace path — run \`dorkos harness sync --fix\` in those to see why.`,
    });
  } else {
    logger.info('[HarnessSync] Agent workspace skill backfill complete', summary);
  }
  return summary;
}
