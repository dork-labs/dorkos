/**
 * The generated per-harness hooks files: writing them, deciding what may be
 * written, and pruning the ones the engine wrote and no longer needs.
 *
 * These live apart from `apply.ts` because they are the one projection kind
 * whose target the engine does NOT own by path — Codex and Cursor both document
 * `.codex/hooks.json` and `.cursor/hooks.json` as files a person may write, so
 * every decision here routes through the `.dorkos-generated` sidecar in
 * `generated-ownership.ts`. Keeping them together is what makes the four answers
 * (write it, adopt it, leave it, prune it) readable as one rule instead of four
 * scattered guards.
 *
 * @module apply/generated-targets
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectionAction, ProjectionPlan } from '../plan/types.js';
import { requireActionContent } from '../plan/content-map.js';
import { CODEX_HOOKS_TARGET, GENERATED_HOOK_TARGETS } from '../generate/hooks.js';
import {
  GENERATED_SIDECAR_SUFFIX,
  HAND_WRITTEN_HOOKS_REASON,
  hasGeneratedSidecar,
  isLegacyBareCodexHooks,
  ownsGeneratedFile,
  readFileIfPresent,
  removeGeneratedSidecar,
  writeGeneratedSidecar,
} from './generated-ownership.js';
import { blockingGenerateOccupant } from './generate-occupants.js';

/** True when a target is one of the per-harness hooks files the sidecar rules guard. */
export function isGeneratedHookTarget(
  target: string
): target is (typeof GENERATED_HOOK_TARGETS)[number] {
  return (GENERATED_HOOK_TARGETS as readonly string[]).includes(target);
}

/** Write a generated hook file and record the engine's ownership of those bytes. */
function writeOwnedGenerated(absTarget: string, content: string): void {
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, content);
  writeGeneratedSidecar(absTarget, content);
}

/**
 * What applying a generated hooks file to its current on-disk state would do.
 * One predicate, read by {@link applyGeneratedHookFile} (which acts on it), by
 * {@link findBlockedGeneratedHookTargets}, and by `apply.ts`'s drift check
 * (which both report it), so the three can never disagree about who owns a file.
 */
export type GeneratedHookOutcome = 'write' | 'adopt' | 'unchanged' | 'blocked';

/**
 * Decide what the engine may do with a generated hooks file.
 *
 * Codex and Cursor both document these paths as files a person may write, so the
 * engine writes one only when it can prove it wrote what is there — a
 * `.dorkos-generated` sidecar whose digest still matches the bytes on disk.
 *
 * Two migrations cover files written before sidecars existed, in order:
 *
 * 1. the bytes are already exactly what would be written now — adopt silently by
 *    recording the sidecar;
 * 2. `.codex/hooks.json` holding the engine's own pre-DOR-1842 bare event map,
 *    with no sidecar ever written — rewrite it into the shape Codex documents.
 *
 * Anything else is somebody's own file: `blocked`.
 *
 * @param absTarget - absolute path of the generated file.
 * @param target - its repo-relative path (which harness's file it is).
 * @param content - the bytes the plan would write.
 * @param onDisk - what is there now, or `undefined` when nothing readable is.
 * @returns the outcome an apply would produce.
 */
export function generatedHookOutcome(
  absTarget: string,
  target: string,
  content: string,
  onDisk: string | undefined
): GeneratedHookOutcome {
  if (onDisk === undefined) return 'write'; // absent: the engine's to create
  // Ours. Rewrite only on a real change: these paths are watched, and a write
  // that changes nothing is still a change event for whoever is watching.
  if (ownsGeneratedFile(absTarget, onDisk)) return onDisk === content ? 'unchanged' : 'write';
  if (onDisk === content) return 'adopt'; // migration 1: byte-for-byte already
  if (
    target === CODEX_HOOKS_TARGET &&
    !hasGeneratedSidecar(absTarget) &&
    isLegacyBareCodexHooks(onDisk)
  ) {
    return 'write'; // migration 2: our own legacy output
  }
  return 'blocked';
}

/**
 * (Re)write one generated hooks file, subject to the sidecar ownership rules.
 *
 * @param absTarget - absolute path of the generated file.
 * @param target - its repo-relative path (which harness's file it is).
 * @param content - the bytes the plan would write.
 * @returns `true` when the target now matches the plan; `false` when a file the
 *   engine does not own occupies it — a conflict, left untouched.
 */
export function applyGeneratedHookFile(
  absTarget: string,
  target: string,
  content: string
): boolean {
  switch (generatedHookOutcome(absTarget, target, content, readFileIfPresent(absTarget))) {
    case 'write':
      writeOwnedGenerated(absTarget, content);
      return true;
    case 'adopt':
      writeGeneratedSidecar(absTarget, content);
      return true;
    case 'unchanged':
      return true;
    case 'blocked':
      return false;
  }
}

/**
 * Prune orphaned generated hook files (e.g. `.codex/hooks.json`) — but only the
 * ones the engine can prove it wrote.
 *
 * When the plugin that contributed the only Codex-mappable hook is uninstalled,
 * the projector emits no `generate` action for that path and the file is left
 * stale on disk. This sweep removes it, the mirror of the symlink orphan sweep in
 * `apply.ts` — behind one guard, ownership, because Codex's and Cursor's own docs
 * tell people to hand-write exactly these paths (HK-11):
 *
 * The file goes only when its `.dorkos-generated` sidecar's digest still matches
 * the bytes on disk. A file with no sidecar was never the engine's; a file whose
 * bytes no longer match is one somebody edited after the engine wrote it. Both
 * are left alone, sidecar included. The file and its sidecar are always removed
 * together, so no half-swept path is ever left claiming ownership; a sidecar
 * whose file is already gone is removed on its own.
 *
 * Ownership is the WHOLE guard — the manifest is deliberately not consulted. A
 * harness leaving the manifest means DorkOS stops projecting into it, and
 * leaving a live hooks file behind would be the opposite of that; the sidecar
 * makes those bytes unambiguously the engine's to take back. Nothing a person
 * wrote is reachable either way, which is what AP-07 is actually protecting.
 *
 * A path the plan still generates is kept (the apply pass rewrites it), so this
 * never races a live projection.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths pruned, sidecars included.
 */
export function sweepGeneratedOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const regenerated = new Set(
    plan.actions.filter((a) => a.kind === 'generate' && a.target).map((a) => a.target as string)
  );

  const swept: string[] = [];
  for (const rel of GENERATED_HOOK_TARGETS) {
    if (regenerated.has(rel)) continue; // still generated by the current plan, keep (apply rewrites it)
    const abs = join(repoRoot, rel);
    const sidecarRel = `${rel}${GENERATED_SIDECAR_SUFFIX}`;
    const onDisk = readFileIfPresent(abs);
    if (onDisk === undefined) {
      // No readable file here. A sidecar left behind describes nothing, so it goes.
      if (hasGeneratedSidecar(abs)) {
        removeGeneratedSidecar(abs);
        swept.push(sidecarRel);
      }
      continue;
    }
    if (!ownsGeneratedFile(abs, onDisk)) continue; // somebody else's file — never ours to delete
    rmSync(abs, { force: true });
    removeGeneratedSidecar(abs);
    swept.push(rel, sidecarRel);
  }
  return swept;
}

/**
 * Generated hook paths where somebody's own file sits and the current plan wants
 * to write NOTHING — the first auto-projection pass, which has no hook
 * contributors by design, or a harness the manifest never enabled.
 *
 * Nothing is blocked in that case: the engine had no projection to make there, so
 * this is a statement, not a fault. It is reported separately from `conflicts`
 * precisely so it cannot become a standing non-zero exit for somebody whose only
 * crime is writing their own `.codex/hooks.json`.
 *
 * A target the plan DOES write is settled by {@link applyGeneratedHookFile}
 * instead, and a file the engine owns belongs to {@link sweepGeneratedOrphans},
 * so neither is listed here.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns the repo-relative paths the engine stepped over.
 */
export function findLeftAloneGeneratedHookFiles(repoRoot: string, plan: ProjectionPlan): string[] {
  const planned = new Set(
    plan.actions.filter((a) => a.kind === 'generate' && a.target).map((a) => a.target as string)
  );

  const leftAlone: string[] = [];
  for (const rel of GENERATED_HOOK_TARGETS) {
    if (planned.has(rel)) continue;
    const abs = join(repoRoot, rel);
    const onDisk = readFileIfPresent(abs);
    if (onDisk === undefined) continue; // nothing readable there
    if (ownsGeneratedFile(abs, onDisk)) continue; // ours; the sweep decides its fate
    leftAlone.push(rel);
  }
  return leftAlone;
}

/**
 * Generate actions the engine cannot realize — what `--fix` reports as a
 * conflict, answered without touching disk so `--check` says the same thing
 * first. Two reasons, asked in that order because one is about the path and the
 * other about its contents:
 *
 * 1. the target's SHAPE forbids a write at all — a directory, or a live symlink
 *    that would carry the write somewhere else ({@link blockingGenerateOccupant});
 * 2. for the per-harness hooks files only, a file the engine cannot prove it
 *    wrote occupies the target ({@link generatedHookOutcome}).
 *
 * One loop and an early `continue` keep them exclusive, so a path is named once
 * with one reason rather than twice with two.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns the blocked actions, each carrying the reason that applies to it.
 */
export function findBlockedGenerateTargets(
  repoRoot: string,
  plan: ProjectionPlan
): ProjectionAction[] {
  const blocked: ProjectionAction[] = [];
  for (const action of plan.actions) {
    if (action.kind !== 'generate' || !action.target) continue;
    const absTarget = join(repoRoot, action.target);

    const shape = blockingGenerateOccupant(absTarget);
    if (shape !== undefined) {
      blocked.push({ ...action, reason: shape });
      continue;
    }

    if (!isGeneratedHookTarget(action.target)) continue;
    const outcome = generatedHookOutcome(
      absTarget,
      action.target,
      requireActionContent(action),
      readFileIfPresent(absTarget)
    );
    if (outcome === 'blocked') blocked.push({ ...action, reason: HAND_WRITTEN_HOOKS_REASON });
  }
  return blocked;
}
