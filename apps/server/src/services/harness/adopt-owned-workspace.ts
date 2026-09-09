/**
 * The one place the server consults `harness.autoAdopt`, and the only place it
 * moves a skill without anybody asking.
 *
 * **It is called from exactly two sites, and both of them have already
 * established that DorkOS owns the directory they are standing in**
 * ({@link https://linear.app/dorkspace/issue/DOR-1853 DOR-1853}, contract §16
 * D3): `backfillAgentWorkspaceSkills` per workspace that passed
 * {@link isAgentHome}, and `RoomWorktreeManager`'s seed-and-project pairing per
 * worktree under `<dorkHome>/rooms/<roomId>/worktrees/`. `runAutoProjection`,
 * `projectOnAgentCreated` and the `.agents/skills` watcher all run in
 * directories a PERSON owns and none of them calls this at all — so a `true` in
 * a plain project is inert by construction rather than by a check somebody could
 * forget, and the terminal says so once (`dorkos harness sync`, S8).
 *
 * **Ownership is a path question and the engine never asks it.**
 * `DirectoryOwnership` is an input to `planAdopt`; the caller resolves it from
 * the dork home. `@dorkos/harness` keeps no knowledge of `~/.dork`, which is
 * what lets one engine run offline in a terminal and inside this server, and the
 * `os.homedir()` ban gains no carve-out.
 *
 * **Reading runs whatever the flag says.** With `autoAdopt` off — the default,
 * and therefore what almost every install does — the candidates are still read
 * and still counted, and nothing is planned or moved. That is the whole
 * report-only claim: the default posture finds every candidate and moves none of
 * them.
 *
 * Best-effort throughout. This runs at boot and on the turn path, so an
 * unreadable manifest or a tree that will not walk costs a log line rather than
 * a boot or a turn.
 *
 * **It walks the source tree once, and that is one walk more than the pass it
 * follows already did.** `projectAgentWorkspace` calls `project()`, which builds
 * its own inventory and keeps it: neither the plan it returns nor the status
 * that comes back out carries one, so there is nothing for a caller to hand
 * over. Threading the inventory through would mean widening `project()`'s
 * return for three callers, two of which never adopt — so the second walk is
 * accepted for now and the widening is the follow-up (DOR-1945). The cost is one
 * directory walk per owned workspace per boot, on a pass that is already
 * best-effort and already yields to the event loop between workspaces.
 *
 * @module services/harness/adopt-owned-workspace
 */
import {
  adoptCommandFor,
  adoptableSentence,
  applyAdopt,
  harnessesThatCannotSee,
  inventorySourceTree,
  loadManifest,
  planAdopt,
  readAdoptCandidates,
  type AdoptCandidate,
  type DirectoryOwnership,
  type SkillRoot,
} from '@dorkos/harness';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { RUNNABLE_HARNESSES } from '@dorkos/shared/harness-schemas';
import { logger } from '../../lib/logger.js';
import { configManager } from '../core/config-manager.js';

/** What one owned workspace's adopt pass found and did. */
export interface OwnedWorkspaceAdoptOutcome {
  /**
   * SKILLS that live only in one agent tool's own folder in this workspace AND
   * that at least one harness DorkOS can RUN here cannot see — found, whatever
   * was done about them.
   *
   * "Can run here", never "the manifest enables": a workspace DorkOS scaffolds
   * enables `claude-code` alone, and an agent in it is runtime-agnostic. See the
   * module docs.
   */
  adoptable: number;
  /** How many of those this pass actually moved. Zero unless the flag is on. */
  adopted: number;
  /** The names found, sorted, for the caller's log line. */
  skills: string[];
  /**
   * One headline per root, in the ABSOLUTE `--project` form (S1d/S1e), plus one
   * command line per skill where a headline could not name them all.
   *
   * Empty when every agent tool this workspace enables can already see every
   * candidate: a claim about tools has to be true, and a count of zero problems
   * is noise ({@link adoptableSentence}).
   */
  lines: string[];
  /** One frozen sentence per skill this pass would not move, with the way out. */
  refusals: { name: string; reason: string }[];
  /**
   * One sentence about the DIRECTORY that stopped every candidate at once —
   * a gitignored `.agents/` (AP-15, S3) — absent when nothing did.
   *
   * Its own field rather than a refusal with an empty name, because it names no
   * skill: repeating it once per candidate would print the same paragraph six
   * times, and a refusal whose `skill` is `''` reads as a refusal that lost the
   * skill it was about.
   */
  blocked?: string;
}

/** Nothing found, nothing done — the answer for a workspace with no candidates. */
const NOTHING: OwnedWorkspaceAdoptOutcome = {
  adoptable: 0,
  adopted: 0,
  skills: [],
  lines: [],
  refusals: [],
};

/**
 * Whether DorkOS may move a skill on its own, as the running server sees it.
 *
 * Its own function so the one read is greppable and so a caller cannot reach the
 * leaf by a second route. See the module docs for why no other trigger asks.
 *
 * @returns True when `harness.autoAdopt` is on.
 */
function autoAdoptPermitted(): boolean {
  return configManager.get('harness').autoAdopt;
}

/**
 * The same answer, read straight off `config.json` without opening the store.
 *
 * For the CLI, and for exactly the reason `dorkosHarnessFromDisk` exists
 * (DOR-678): `dorkos harness sync --check` is documented as never writing
 * anything, and opening a `conf` store is not a read — its constructor creates
 * the directory and writes `config.json` when either is missing, so a check run
 * from the wrong folder would plant a `~/.dork` there. Both readers parse the
 * SAME Zod schema, so they cannot drift.
 *
 * A file that is absent, unparseable, or carrying a `harness` block the schema
 * rejects resolves to the schema's own default, which is `false` — the answer
 * that prints nothing and moves nothing.
 *
 * @param dorkHome - The resolved DorkOS data directory holding `config.json`.
 * @returns True when `harness.autoAdopt` is on.
 */
export function autoAdoptFromDisk(dorkHome: string): boolean {
  const fallback = UserConfigSchema.shape.harness.parse(undefined).autoAdopt;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dorkHome, 'config.json'), 'utf8'));
  } catch {
    return fallback;
  }
  const parsed = UserConfigSchema.shape.harness.safeParse(
    (raw as { harness?: unknown } | null)?.harness
  );
  return parsed.success ? parsed.data.autoAdopt : fallback;
}

/**
 * Read every adoptable skill in one directory DorkOS owns that some enabled
 * agent tool cannot see, and move the allowlisted ones when `harness.autoAdopt`
 * says so.
 *
 * **The "cannot see it" question is asked against every harness DorkOS can RUN
 * here, not against the manifest** ({@link RUNNABLE_HARNESSES}), and the same
 * answer drives the count, the sentence and the ACTION — keeping the three
 * together is the point.
 *
 * The manifest is the wrong oracle in exactly these two directories. A workspace
 * DorkOS scaffolds enables `claude-code` alone (`AGENT_WORKSPACE_HARNESSES`),
 * because that is the only harness anything has to project files for; ask it who
 * cannot see a `.claude/skills` skill and it answers "nobody". That is true
 * about projection and false about the agent: `runtimeRegistry` binds a SESSION,
 * not an agent, so the same agent's next Codex or OpenCode session runs in that
 * folder and reads none of `.claude/skills` — which is D3's own argument,
 * applied in the direction that makes the report true rather than the direction
 * that silences it. Keying the filter off the manifest instead made every real
 * agent home a silent no-op: nothing counted, nothing reported, and nothing
 * moved with the flag on.
 *
 * The filter itself removes nothing today, and it is kept anyway: every
 * harness-owned root is unreadable by at least one runnable harness (measured —
 * `.claude/skills` by Codex, every other one by two or three of them), so the
 * question always answers yes. It exists so the count and the sentence are the
 * SAME set by construction rather than by coincidence, which is what stops a
 * line being logged with an empty command list under it if the runtime table or
 * a vendor's read paths ever move. `auto-adopt.test.ts` asserts the property
 * over the engine's roots rather than assuming it.
 *
 * The manifest keeps every other job it had. It decides whether a move leaves
 * Claude Code's link behind, because that link is a PROJECTION and projection is
 * what the manifest governs; and `dorkos harness adopt` in a project a PERSON
 * owns keeps the manifest as its oracle, because there the enabled set is their
 * own statement of which tools they run.
 *
 * @param workspaceDir - Absolute path to the owned workspace.
 * @param ownership - What DorkOS owns it as, decided by the caller.
 * @returns What was found, what moved, and the sentences for the caller to log.
 */
export function adoptInOwnedWorkspace(
  workspaceDir: string,
  ownership: Extract<DirectoryOwnership, 'agent-home' | 'room-worktree'>
): OwnedWorkspaceAdoptOutcome {
  try {
    const manifest = loadManifest(workspaceDir);
    const read = readAdoptCandidates(workspaceDir, inventorySourceTree(workspaceDir), manifest);
    // Sorted once, here, so every count, every name and every sentence below is
    // in the same order — and narrowed to the skills some harness DorkOS can RUN
    // here cannot see, which is the question the manifest cannot answer in a
    // folder DorkOS owns (see the docs above).
    const found = read.candidates
      .filter((candidate) => harnessesThatCannotSee(candidate.root, RUNNABLE_HARNESSES).length > 0)
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    if (found.length === 0) return NOTHING;

    const skills = found.map((candidate) => candidate.name);
    if (!autoAdoptPermitted()) {
      return {
        adoptable: found.length,
        adopted: 0,
        skills,
        lines: sentencesFor(found, workspaceDir),
        refusals: [],
      };
    }

    // R7 is hard in auto mode and there is no `--force`, so what comes back is
    // only ever the allowlisted skills — the engine's guarantee, not a filter
    // repeated here.
    const plan = planAdopt({
      ...read,
      candidates: found,
      request: { mode: 'auto' },
      ownership,
    });
    const result = applyAdopt(workspaceDir, plan);
    const moved = new Set(result.moved.map((move) => move.name));

    return {
      adoptable: found.length,
      adopted: result.moved.length,
      skills,
      // Built AFTER the moves, so the lines name what is still only in one
      // tool's folder rather than what was there when the pass started.
      lines: sentencesFor(
        found.filter((candidate) => !moved.has(candidate.name)),
        workspaceDir
      ),
      refusals: result.refusals.map((refusal) => ({
        name: refusal.name,
        reason: refusal.reason,
      })),
      // A run-level `blocked` stops every candidate at once (a gitignored
      // `.agents/`, AP-15). It is about the DIRECTORY rather than about any one
      // skill, so it is carried on its own field and printed on its own line —
      // a refusal with an empty name reads as a refusal that lost its skill.
      ...(plan.blocked === undefined ? {} : { blocked: plan.blocked.reason }),
    };
  } catch (err) {
    logger.warn('[HarnessSync] Reading adoptable skills failed (non-fatal)', {
      workspaceDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return NOTHING;
  }
}

/**
 * The headlines a server surface prints, one per root, in the absolute form.
 *
 * `projectPath` is always passed: this is a sentence DorkOS prints from the
 * SERVER, and the reader is not standing in that directory, so a bare command
 * would mean whatever folder they happen to be in — DOR-1921's measurement.
 *
 * The tools it names are {@link RUNNABLE_HARNESSES}, the same set the filter
 * above uses, so the sentence can never name a tool the count did not consider.
 *
 * @param candidates - the skills still only in one agent tool's folder.
 * @param workspaceDir - the absolute workspace root, for the `--project`.
 * @returns the lines, empty when there is nothing honest to say.
 */
function sentencesFor(candidates: readonly AdoptCandidate[], workspaceDir: string): string[] {
  const byRoot = new Map<SkillRoot, string[]>();
  for (const candidate of candidates) {
    byRoot.set(candidate.root, [...(byRoot.get(candidate.root) ?? []), candidate.name]);
  }

  const lines: string[] = [];
  // By folder name, so the block reads the same way twice on one tree: the map's
  // own order is the inventory's walk order, which is a fact about a filesystem
  // rather than about this report.
  for (const [root, names] of [...byRoot].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...names].sort();
    const headline = adoptableSentence({
      root,
      names: sorted,
      cannotSee: harnessesThatCannotSee(root, RUNNABLE_HARNESSES),
      projectPath: workspaceDir,
    });
    if (headline === '') continue;
    lines.push(headline);
    // A headline cannot name three skills in one command, and a list of names
    // with no command is a second thing to look up — so each skill carries its
    // own, in full.
    if (sorted.length > 1)
      for (const name of sorted) lines.push(adoptCommandFor(name, workspaceDir));
  }
  return lines;
}
