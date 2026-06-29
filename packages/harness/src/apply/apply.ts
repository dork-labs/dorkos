/**
 * Apply / check — realize a {@link ProjectionPlan} on disk, or diff against it.
 *
 * `applyPlan` materializes symlinks, scaffolds, and generated files idempotently,
 * never overwriting a hand-authored scaffold body (those surface as `conflicts`).
 * `checkPlan` reports drift without touching disk. Both read deterministic bytes
 * for `scaffold`/`generate` actions from the projector via {@link getActionContent}.
 *
 * @module apply/apply
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DriftResult, ProjectionAction, ProjectionPlan } from '../plan/types.js';
import { getActionContent } from '../plan/content-map.js';

/** True when a path exists on disk (including a broken symlink). */
function pathExists(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/** True when the path is itself a symlink (not its target). */
function isSymlink(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The relative symlink text that points from `target` to `source`. */
function relativeLink(repoRoot: string, source: string, target: string): string {
  return relative(dirname(join(repoRoot, target)), join(repoRoot, source));
}

/** Read the deterministic bytes the projector attached to a scaffold/generate action. */
function requireContent(action: ProjectionAction): string {
  const content = getActionContent(action);
  if (content === undefined) {
    throw new Error(
      `${action.kind} action for "${action.name}" has no attached content; the projector must call setActionContent`
    );
  }
  return content;
}

/** Create or repair a relative symlink for a `symlink` action. */
function applySymlink(repoRoot: string, action: ProjectionAction): void {
  if (!action.source || !action.target) {
    throw new Error(`symlink action for "${action.name}" is missing source/target`);
  }
  const absTarget = join(repoRoot, action.target);
  const linkText = relativeLink(repoRoot, action.source, action.target);

  mkdirSync(dirname(absTarget), { recursive: true });
  if (pathExists(absTarget)) {
    if (isSymlink(absTarget) && readlinkSync(absTarget) === linkText) return; // already correct
    rmSync(absTarget, { recursive: true, force: true });
  }
  symlinkSync(linkText, absTarget);
}

/**
 * Write a scaffold target.
 *
 * @returns `true` when the target now matches the plan (written or already
 *   identical), `false` when a *different* file already exists — a conflict that
 *   must never be overwritten.
 */
function applyScaffold(repoRoot: string, action: ProjectionAction): boolean {
  if (!action.target) throw new Error(`scaffold action for "${action.name}" is missing target`);
  const content = requireContent(action);
  const absTarget = join(repoRoot, action.target);

  if (!pathExists(absTarget)) {
    mkdirSync(dirname(absTarget), { recursive: true });
    writeFileSync(absTarget, content);
    return true;
  }
  return readFileSync(absTarget, 'utf8') === content;
}

/** (Re)write a generated target deterministically. */
function applyGenerate(repoRoot: string, action: ProjectionAction): void {
  if (!action.target) throw new Error(`generate action for "${action.name}" is missing target`);
  const content = requireContent(action);
  const absTarget = join(repoRoot, action.target);
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, content);
}

/**
 * Realize a projection plan on disk.
 *
 * `native`/`drop` actions are no-ops. `symlink`/`generate` are written
 * idempotently. A `scaffold` whose target already holds a different,
 * hand-authored body is left untouched and reported in `conflicts`.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the projection plan to apply.
 * @returns the actions that were realized and the scaffold conflicts left intact.
 */
export function applyPlan(
  repoRoot: string,
  plan: ProjectionPlan
): { applied: ProjectionAction[]; conflicts: ProjectionAction[] } {
  const applied: ProjectionAction[] = [];
  const conflicts: ProjectionAction[] = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'symlink':
        applySymlink(repoRoot, action);
        applied.push(action);
        break;
      case 'scaffold':
        if (applyScaffold(repoRoot, action)) applied.push(action);
        else conflicts.push(action);
        break;
      case 'generate':
        applyGenerate(repoRoot, action);
        applied.push(action);
        break;
      case 'native':
      case 'drop':
        break;
    }
  }

  return { applied, conflicts };
}

/** Whether a single action's on-disk target diverges from the plan. */
function isDrifted(repoRoot: string, action: ProjectionAction): boolean {
  switch (action.kind) {
    case 'symlink': {
      if (!action.source || !action.target) return true;
      const absTarget = join(repoRoot, action.target);
      if (!isSymlink(absTarget)) return true;
      return readlinkSync(absTarget) !== relativeLink(repoRoot, action.source, action.target);
    }
    case 'scaffold':
      return !action.target || !pathExists(join(repoRoot, action.target));
    case 'generate': {
      if (!action.target) return true;
      const absTarget = join(repoRoot, action.target);
      if (!pathExists(absTarget)) return true;
      return readFileSync(absTarget, 'utf8') !== requireContent(action);
    }
    case 'native':
    case 'drop':
      return false;
  }
}

/**
 * Diff a projection plan against the current on-disk state without mutating it.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the projection plan to check.
 * @returns the drifted actions and whether the tree is clean.
 */
export function checkPlan(repoRoot: string, plan: ProjectionPlan): DriftResult {
  const drifted = plan.actions.filter((action) => isDrifted(repoRoot, action));
  return { drifted, clean: drifted.length === 0 };
}
