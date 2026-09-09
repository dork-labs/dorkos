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
  type HarnessId,
  type SkillRoot,
} from '@dorkos/harness';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { logger } from '../../lib/logger.js';
import { configManager } from '../core/config-manager.js';

/** What one owned workspace's adopt pass found and did. */
export interface OwnedWorkspaceAdoptOutcome {
  /**
   * SKILLS that live only in one agent tool's own folder in this workspace —
   * found, whatever was done about them.
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
 * Read every adoptable skill in one directory DorkOS owns, and move the
 * allowlisted ones when `harness.autoAdopt` says so.
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
    if (read.candidates.length === 0) return NOTHING;

    const found = [...read.candidates].sort((a, b) => (a.name < b.name ? -1 : 1));
    const lines = sentencesFor(found, read.enabledHarnesses, workspaceDir);
    if (!autoAdoptPermitted()) {
      return {
        adoptable: found.length,
        adopted: 0,
        skills: found.map((c) => c.name),
        lines,
        refusals: [],
      };
    }

    // R7 is hard in auto mode and there is no `--force`, so what comes back is
    // only ever the allowlisted skills — the engine's guarantee, not a filter
    // repeated here.
    const plan = planAdopt({ ...read, request: { mode: 'auto' }, ownership });
    const result = applyAdopt(workspaceDir, plan);
    // A run-level `blocked` stops every candidate at once (a gitignored
    // `.agents/`, AP-15). It is reported like a refusal rather than swallowed,
    // because the person's way out is in its sentence.
    const blocked = plan.blocked === undefined ? [] : [{ name: '', reason: plan.blocked.reason }];

    return {
      adoptable: found.length,
      adopted: result.moved.length,
      skills: found.map((c) => c.name),
      // Recomputed AFTER the moves, so the lines name what is still only in one
      // tool's folder rather than what was there when the pass started.
      lines: sentencesFor(
        found.filter((c) => !result.moved.some((m) => m.name === c.name)),
        read.enabledHarnesses,
        workspaceDir
      ),
      refusals: [...blocked, ...result.refusals.map((r) => ({ name: r.name, reason: r.reason }))],
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
 * @param candidates - the skills still only in one agent tool's folder.
 * @param enabled - the harnesses the workspace's manifest enables, in its order.
 * @param workspaceDir - the absolute workspace root, for the `--project`.
 * @returns the lines, empty when there is nothing honest to say.
 */
function sentencesFor(
  candidates: readonly AdoptCandidate[],
  enabled: readonly HarnessId[],
  workspaceDir: string
): string[] {
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
      cannotSee: harnessesThatCannotSee(root, enabled),
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
