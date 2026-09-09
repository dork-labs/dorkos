/**
 * The filesystem half of adopt: one `rename(2)` per move, and the projection the
 * planner already planned.
 *
 * **There is no staging directory and no backup, unlike the marketplace
 * transaction, and that is a decision rather than an omission.** That module
 * stages because it BUILDS content that does not exist yet, and backs up because
 * it OVERWRITES an occupied target. Adopt does neither: R4 refuses an occupied
 * target outright, so there is nothing to back up, and it moves content that is
 * already whole and already valid, so there is nothing to stage. Staging would
 * buy a copy step that is not atomic, plus lost hard links and mode bits, in
 * exchange for closing a window `rename(2)` does not have.
 *
 * What it does keep from that module is the discipline: refuse rather than
 * overwrite, one mutating step, and restore on failure.
 *
 * **What a crash between the move and the link leaves, stated rather than
 * hoped.** The skill directory whole at `.agents/skills/<name>`, and nothing at
 * the old path. Nothing is lost — every byte is at the canonical root, which
 * five of the six agent tools read natively — and what is missing is Claude
 * Code's symlink, which is precisely the `symlink` action `planSkill` plans for
 * that skill on every subsequent run. The crash state is drift, which this
 * engine already names and fixes, not damage.
 *
 * @module adopt/apply
 */
import { lstatSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyPlan } from '../apply/apply.js';
import { declareClaudeOnlySkill } from '../scaffold/declare-claude-only.js';
import { ADOPT_SENTENCES } from './refusals.js';
import {
  ADOPT_TARGET_ROOT,
  type AdoptDeclaration,
  type AdoptMove,
  type AdoptPlan,
  type AdoptRefusal,
  type AdoptResult,
} from './types.js';

/**
 * Carry out one adopt plan.
 *
 * A plan carries either moves or declarations, never both for one name: R8's
 * short-circuit settles which one a run is doing before anything is planned.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - what {@link planAdopt} decided.
 * @returns what actually happened, with the plan's own refusals plus any this
 *   apply raised.
 */
export function applyAdopt(repoRoot: string, plan: AdoptPlan): AdoptResult {
  const moved: AdoptMove[] = [];
  const declared: AdoptDeclaration[] = [];
  const refusals: AdoptRefusal[] = [...plan.refusals];

  for (const move of plan.moves) {
    const refusal = applyMove(repoRoot, move);
    if (refusal === undefined) moved.push(move);
    else refusals.push(refusal);
  }

  for (const declaration of plan.declarations) {
    const refusal = applyDeclaration(repoRoot, declaration);
    if (refusal === undefined) declared.push(declaration);
    else refusals.push(refusal);
  }

  return { moved, declared, refusals };
}

/**
 * Move one skill, then leave the link the plan carries — and put everything back
 * if the link cannot be written.
 *
 * The order is the whole of the guarantee, and there is no other:
 *
 * 1. `mkdir -p .agents/skills`. Creating a directory that may already exist is
 *    not a mutation anybody can observe.
 * 2. `renameSync`. **The single mutating step**, atomic because both paths are
 *    inside one repository and therefore on one filesystem.
 * 3. The link, through the engine's own `applyPlan` rather than a `symlinkSync`
 *    here — same function every sync uses, same relative link text, same
 *    `symlinkType` answer on Windows.
 * 4. If step 3 threw or reported a conflict: rename back, and refuse with the
 *    conflict's own reason. The restore is one rename into a path this same
 *    process vacated a moment ago, so it cannot fail for a reason step 2 did not
 *    already prove impossible.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param move - the move to carry out.
 * @returns the refusal, or `undefined` when the skill landed.
 */
function applyMove(repoRoot: string, move: AdoptMove): AdoptRefusal | undefined {
  const absFrom = join(repoRoot, move.from);
  const absTo = join(repoRoot, move.to);

  // Creating the canonical layer is not a mutation anybody can observe WHEN THE
  // MOVE LANDS — but a refusal has to leave the tree exactly as it found it, so
  // a directory this call created and then did not use is taken back down.
  const canonicalLayer = join(repoRoot, ADOPT_TARGET_ROOT);
  const layerExisted = somethingIsAt(canonicalLayer);
  mkdirSync(canonicalLayer, { recursive: true });
  try {
    renameSync(absFrom, absTo);
  } catch (err) {
    if (!layerExisted) removeIfEmpty(canonicalLayer);
    // `EXDEV` is REFUSED, never degraded to a copy-then-delete: that is the one
    // alternative, it is not atomic, and its failure mode is exactly the
    // half-moved skill this design promises never to leave.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      return {
        name: move.name,
        source: move.from,
        rule: 'cross-device',
        reason: ADOPT_SENTENCES.S10(move.from),
      };
    }
    throw err;
  }

  if (move.link === undefined) return undefined;

  let blocked: string | undefined;
  try {
    // No `sweepOrphans`: `applyPlan` throws when a narrowed plan asks for a
    // sweep, which is the backstop rather than a rule to remember.
    const result = applyPlan(
      repoRoot,
      {
        actions: [move.link],
        drops: [],
        warnings: [],
        notEnabled: [],
        narrowedTo: 'claude-code',
      },
      {}
    );
    const conflict = result.conflicts[0];
    if (conflict === undefined) return undefined;
    // `applySymlink` names its own occupant, so the conflict carries the
    // sentence a sync would have printed about the same file (S17's rule, one
    // step further along). The fallback is for the shape of the type rather than
    // for a case a symlink conflict can reach: `reason` is optional on an
    // action, and a conflict without one would otherwise refuse in silence.
    blocked = conflict.reason ?? `Something is in the way at ${move.link.target}.`;
  } catch (err) {
    blocked = err instanceof Error ? err.message : String(err);
  }

  return restore({ repoRoot, move, absFrom, absTo, blocked, layerExisted });
}

/**
 * Put the skill back where it was, and say what happened when that is no longer
 * possible.
 *
 * The ordinary case is one rename into a path this same process vacated a moment
 * ago, which cannot fail for a reason the move did not already prove impossible.
 *
 * The exception is the reason this is a function. For a `.claude/skills` source
 * the link's target IS the path the move vacated, so the only thing that can
 * block the link is something arriving at the old path while this ran — and a
 * rename back onto it would either fail or, worse, be asked to destroy whatever
 * a person just put there. So the skill stays whole at the canonical root, which
 * is the same state a crash between the two steps leaves: drift the next sync
 * fixes, named out loud rather than hidden behind a refusal that says nothing
 * happened.
 *
 * @param input - the repository root, the move, both absolute paths, why the
 *   link could not be written in the engine's own words, and whether the
 *   canonical layer was there before this call.
 * @returns the refusal to report.
 */
function restore(input: {
  repoRoot: string;
  move: AdoptMove;
  absFrom: string;
  absTo: string;
  blocked: string;
  layerExisted: boolean;
}): AdoptRefusal {
  const { repoRoot, move, absFrom, absTo, blocked, layerExisted } = input;
  if (!somethingIsAt(absFrom)) {
    renameSync(absTo, absFrom);
    if (!layerExisted) removeIfEmpty(join(repoRoot, ADOPT_TARGET_ROOT));
    return { name: move.name, source: move.from, rule: 'link-blocked', reason: blocked };
  }
  return {
    name: move.name,
    source: move.from,
    rule: 'link-blocked',
    reason:
      `${blocked} Your skill is safe at ${move.to}, where every agent but Claude Code reads it. ` +
      `Clear ${move.from}, then run dorkos harness sync --fix to give Claude Code its link back.`,
  };
}

/**
 * Take back down a directory this call created and then did not use.
 *
 * `rmdir`, never `rm -r`: it refuses a directory with anything in it, so a
 * cleanup can only ever remove the empty folder it made. A concurrent writer
 * that put something there in the meantime keeps it.
 *
 * @param abs - the absolute directory path.
 */
function removeIfEmpty(abs: string): void {
  try {
    rmdirSync(abs);
  } catch {
    // Not empty, or already gone: either way there is nothing to take back.
  }
}

/**
 * Whether anything at all is at a path.
 *
 * `lstat`, never `exists`: a dangling link is still something occupying the old
 * path, and renaming a directory onto one fails just as loudly as renaming it
 * onto a file.
 *
 * @param abs - the absolute path to ask about.
 * @returns whether the path is taken.
 */
function somethingIsAt(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record one declaration, which is the other thing this module writes and is not
 * a move.
 *
 * One element appended to `manifest.claudeOnlySkills` and no other byte of the
 * file touched — the same contract `enableHarnessInManifest` keeps, through the
 * same surgery.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param declaration - the entry to record.
 * @returns the refusal, or `undefined` when it was recorded (or already was).
 */
function applyDeclaration(
  repoRoot: string,
  declaration: AdoptDeclaration
): AdoptRefusal | undefined {
  const written = declareClaudeOnlySkill(repoRoot, declaration);
  if (written.outcome !== 'unwritable') return undefined;
  return {
    name: declaration.name,
    source: declaration.path,
    rule: 'manifest-unwritable',
    reason:
      `DorkOS did not change ${written.path}: ${written.reason}. ` +
      `Add "${declaration.name}" to its "claudeOnlySkills" list yourself.`,
  };
}
