/**
 * What a sync could not look inside — the one thing the sweeps knew and never
 * said (DOR-1939).
 *
 * Every `find*` half reads its directory through `listDir`/`listDirEntries`,
 * which collapse "there is nothing in it" and "nobody could look" into the same
 * empty array. That collapse is deliberate and right for a SCAN — a sweep that
 * cannot look must remove nothing, which is the safe direction, and
 * `link-state.ts` says why. What was missing is the second half of the answer:
 * the person was never told the sweep had stood down. `checkPlan` said `clean:
 * true`, `blocked: []`, `leftAlone: []`, and a stale projection under a mode-000
 * folder sat there unreported for as long as the folder stayed that way.
 *
 * `.opencode/commands` is the sharpest case, and the reason this module exists
 * rather than a note in the inventory: nothing else in the engine goes near it.
 * The inventory does not walk it, and in a repository that does not run OpenCode
 * no plan action targets it, so the only thing that ever opens that folder is
 * `findOpencodeCommandOrphans`.
 *
 * ## Why one pass rather than a warning per finder
 *
 * The six finders answer a different question — WHICH PATHS would go — and each
 * one already has exactly one thing to say about the folder it walked. Threading
 * a second return value through six functions and their six sweeping twins would
 * put the same sentence in twelve places and make `--check` and `--fix` able to
 * disagree about it, which is the failure every table in this directory is
 * written down once to avoid. So the folders the sweeps walk are enumerated here
 * once, both modes call this, and the two cannot answer differently.
 *
 * The enumeration is the whole of the coupling, and it is stated: a seventh
 * sweep that walks a new directory belongs in {@link SWEPT_DIRS} (or in the
 * wildcard pass below) the same day it is written.
 *
 * ## It is a warning, not a fault
 *
 * Nothing is broken by a folder nobody may read: no file is deleted, no file is
 * corrupted, and the tree is exactly as it was. `clean` therefore stays true and
 * `--check` still exits 0 — turning this into an exit code would red a
 * repository with nothing wrong with it. What it earns is a sentence, because
 * "nothing to do" and "could not look" are opposite facts.
 *
 * @module apply/sweep-warnings
 */
import { join } from 'node:path';
import type { ProjectionPlan } from '../plan/types.js';
import { AGENTS_SKILLS_DIR } from '../scan/scanner.js';
import {
  CLAUDE_COMMANDS_DIR,
  CLAUDE_SKILLS_DIR,
  OPENCODE_COMMANDS_DIR,
} from '../plan/installed-projector.js';
import { listDirEntries, pathExists, tryListDir } from './link-state.js';

/**
 * Every directory a sweep lists by name.
 *
 * The skill roots belong to the installed-orphan and authored-orphan sweeps, and
 * the two command directories to the two wrapper sweeps. The generated-hooks
 * sweep and the settings-hooks sweep are deliberately absent: both read named
 * FILES and neither ever lists a directory, so there is no folder for either to
 * be blind inside.
 */
const SWEPT_DIRS = [
  AGENTS_SKILLS_DIR,
  CLAUDE_SKILLS_DIR,
  CLAUDE_COMMANDS_DIR,
  OPENCODE_COMMANDS_DIR,
] as const;

/**
 * The one sentence, written down once for the same reason `sweep-reasons.ts`
 * writes its table down once: the terminal's `--check` and `--fix` blocks and
 * the app's project-level notices all print it verbatim, and two surfaces
 * describing one fact in two voices is how a person stops trusting either.
 *
 * @param relDir - the repo-relative folder nobody could look inside.
 * @returns the sentence to report.
 */
export function sweepBlindWarning(relDir: string): string {
  return (
    `DorkOS could not look inside \`${relDir}\`, so it does not know whether anything a sync ` +
    `would remove is in there. Nothing was taken out of it. If it should be a folder DorkOS ` +
    `can read, fix it and re-run.`
  );
}

/**
 * Every folder a sweep of this plan would have walked and could not list.
 *
 * Pure: it reads the tree and writes nothing, so `applyPlan` and `checkPlan`
 * call the identical function for the identical answer.
 *
 * An ABSENT folder is silent, which is the ordinary case for most of these in
 * most repositories — a warning about each of four folders nobody has ever
 * created would be a wall of notices about nothing. Only a path something really
 * occupies and nothing may list is reported.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (a plan narrowed to one harness
 *   sweeps nothing, so it has nothing to be blind inside either).
 * @returns one sentence per unlistable folder, outermost first, sorted within a
 *   level so the report is deterministic.
 */
export function sweepScanWarnings(repoRoot: string, plan: ProjectionPlan): string[] {
  if (plan.narrowedTo !== undefined) return [];

  const blind: string[] = [];
  for (const rel of SWEPT_DIRS) {
    const abs = join(repoRoot, rel);
    if (!pathExists(abs)) continue;
    if (tryListDir(abs) === undefined) {
      blind.push(rel);
      continue;
    }
    // One level down, and only under `.claude/commands`: it is the only sweep
    // that enumerates by wildcard AND deletes a directory it finds empty, so a
    // wrapper directory it cannot list is the one it most needs to say so
    // about — `tryListDir` is what keeps that deletion off a folder whose
    // contents nobody saw (`apply.ts`), and this is how the person hears about
    // the folder it declined to tidy.
    if (rel !== CLAUDE_COMMANDS_DIR) continue;
    for (const sub of listDirEntries(abs)) {
      if (!sub.isDirectory()) continue;
      if (tryListDir(join(abs, sub.name)) === undefined) blind.push(`${rel}/${sub.name}`);
    }
  }
  return blind.map(sweepBlindWarning);
}
