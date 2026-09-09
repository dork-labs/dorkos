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
import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
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

/**
 * Whether this platform can be asked about write permission at all.
 *
 * Not Windows, for the reason `write-path-occupants.ts` states about the
 * identical probe on the WRITING side: `accessSync(dir, W_OK)` there reports the
 * read-only attribute, which directories do not meaningfully carry, and answers
 * "writable" for a folder an ACL denies. The shapes this protects against are
 * POSIX mode bits, and Windows keeps the behaviour it had — the removal itself
 * reports the failure.
 */
const CAN_ASK_ABOUT_WRITING = process.platform !== 'win32';

/**
 * The sentence for a removal DorkOS may not make, written down once.
 *
 * It names BOTH paths on purpose: the link is what would have gone, and the
 * folder is what has to change for it to go. Every other reason in this engine
 * that is about a folder above a path says so the same way
 * (`write-path-occupants.ts`).
 *
 * @param rel - the repo-relative path a sweep would have removed.
 * @param relDir - the repo-relative folder that refuses the write.
 * @returns the sentence to report.
 */
export function blockedRemovalWarning(rel: string, relDir: string): string {
  return (
    `\`${rel}\` would be removed, and DorkOS may not write in \`${relDir}\` ` +
    `(permission denied), so it was left exactly as it is. Fix the folder’s permissions, ` +
    `then re-run.`
  );
}

/**
 * Whether the folder holding `rel` refuses the write `rmSync` needs.
 *
 * **`rmSync` needs the write bit on the PARENT, not on the entry**, which is
 * why nothing else in this engine had asked: every other probe here is about
 * the path being written, and a deletion writes the directory. Measured at mode
 * 0555 on `.claude/skills` holding a dead link — `checkPlan` promised the
 * removal and `applyPlan` threw EACCES out of the sweep, after the action loop
 * had already written (DOR-1941).
 *
 * The identical `accessSync(dir, W_OK | X_OK)` the write-path probe uses, so a
 * folder DorkOS may not create a link in and a folder it may not remove one from
 * are the same question asked twice rather than two answers about one mode bit.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param rel - the repo-relative path a sweep would remove.
 * @param probed - a memo of folders already answered for; siblings share one.
 * @returns the folder that refuses, or `undefined` when the removal may proceed.
 */
function unwritableParent(
  repoRoot: string,
  rel: string,
  probed: Map<string, boolean>
): string | undefined {
  if (!CAN_ASK_ABOUT_WRITING) return undefined;
  const relDir = dirname(rel);
  const cached = probed.get(relDir);
  if (cached !== undefined) return cached ? relDir : undefined;
  let refuses: boolean;
  try {
    accessSync(join(repoRoot, relDir), constants.W_OK | constants.X_OK);
    refuses = false;
  } catch {
    // A folder that is not there at all cannot hold anything to remove, so the
    // caller never asks about one — every path here came out of a listing.
    refuses = true;
  }
  probed.set(relDir, refuses);
  return refuses ? relDir : undefined;
}

/**
 * Split the paths a sweep found into the ones it may really take and the ones it
 * may not.
 *
 * One function for both halves so `--check` and `--fix` can never disagree about
 * which is which: the preview drops exactly what the sweep would have thrown on,
 * and the sweep skips exactly what the preview declined to promise (AP-07's
 * equality contract, DOR-1889).
 *
 * @param repoRoot - absolute path to the repository root.
 * @param paths - the repo-relative paths one sweep named, in its own order.
 * @returns the paths that may be removed, and one sentence per path that may not.
 */
export function partitionRemovable(
  repoRoot: string,
  paths: readonly string[]
): { removable: string[]; warnings: string[] } {
  const removable: string[] = [];
  const warnings: string[] = [];
  const probed = new Map<string, boolean>();
  for (const rel of paths) {
    const relDir = unwritableParent(repoRoot, rel, probed);
    if (relDir === undefined) removable.push(rel);
    else warnings.push(blockedRemovalWarning(rel, relDir));
  }
  return { removable, warnings };
}

/**
 * The paths a sweep may really take — the half of {@link partitionRemovable}
 * every `find*` returns.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param paths - the repo-relative paths one sweep named.
 * @returns the ones whose folder will take the write.
 */
export function removableOf(repoRoot: string, paths: readonly string[]): string[] {
  return partitionRemovable(repoRoot, paths).removable;
}
