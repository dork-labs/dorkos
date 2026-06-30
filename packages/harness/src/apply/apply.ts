/**
 * Apply / check — realize a {@link ProjectionPlan} on disk, or diff against it.
 *
 * `applyPlan` materializes symlinks and generated files idempotently and scaffolds
 * pointers only when absent. It never destroys hand-authored content: an existing
 * scaffold is left untouched, and a symlink target occupied by a *real* file or
 * directory surfaces as a `conflict` rather than being removed. `checkPlan` reports
 * drift without touching disk. Both read deterministic bytes for `scaffold`/`generate`
 * actions from the projector via {@link getActionContent}.
 *
 * @module apply/apply
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DriftResult, ProjectionAction, ProjectionPlan } from '../plan/types.js';
import { getActionContent } from '../plan/content-map.js';
import { INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';

/** The directory installed-plugin skill projections are swept from (`<pkg>__<skill>` symlinks). */
const INSTALLED_SKILLS_DIR = '.agents/skills';

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

/**
 * The symlink type to request for a source path. Windows needs `'junction'` for
 * directory targets (which skill sources are) to avoid an EPERM without admin /
 * Developer Mode; POSIX ignores the type argument.
 */
function symlinkType(repoRoot: string, source: string): 'junction' | 'file' | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    return lstatSync(join(repoRoot, source)).isDirectory() ? 'junction' : 'file';
  } catch {
    return undefined;
  }
}

/**
 * Create or repair a relative symlink for a `symlink` action.
 *
 * @returns `true` when the symlink now matches the plan; `false` when a *real*
 *   (non-symlink) file or directory occupies the target — a conflict that is left
 *   untouched rather than destroyed, exactly like {@link applyScaffold}.
 */
function applySymlink(repoRoot: string, action: ProjectionAction): boolean {
  if (!action.source || !action.target) {
    throw new Error(`symlink action for "${action.name}" is missing source/target`);
  }
  const absTarget = join(repoRoot, action.target);
  const linkText = relativeLink(repoRoot, action.source, action.target);

  if (pathExists(absTarget)) {
    if (!isSymlink(absTarget)) return false; // a real file/dir — never destroy hand-authored content
    if (readlinkSync(absTarget) === linkText) return true; // already the correct managed symlink
    rmSync(absTarget, { force: true }); // a stale *managed* symlink — safe to replace
  }
  mkdirSync(dirname(absTarget), { recursive: true });
  symlinkSync(linkText, absTarget, symlinkType(repoRoot, action.source));
  return true;
}

/**
 * Scaffold a pointer file if it is absent. An existing file — even one the user
 * has hand-edited — is left untouched: a scaffold is a one-time pointer the user
 * owns, never regenerated. So a scaffold never conflicts and never fails apply,
 * which keeps `--check` (drift = absent) and `--fix` consistent for a customized
 * scaffold (both report it clean).
 */
function applyScaffold(repoRoot: string, action: ProjectionAction): void {
  if (!action.target) throw new Error(`scaffold action for "${action.name}" is missing target`);
  const absTarget = join(repoRoot, action.target);
  if (pathExists(absTarget)) return; // user owns it — never overwrite
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, requireContent(action));
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
 * Sweep orphaned installed-plugin skill projections from `.agents/skills`.
 *
 * Installed projections are namespaced `<pkg>__<skill>` and gitignored — they are
 * exclusively engine-managed, so any `__`-marked entry that is no longer a target
 * in the current plan belongs to an uninstalled plugin and is safe to remove.
 * Authored skills (no `__`) are never touched.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its installed targets are kept).
 * @returns the repo-relative paths swept.
 */
export function sweepInstalledOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const managed = new Set(
    plan.actions
      .filter((a) => a.provenance === 'installed' && a.target)
      .map((a) => a.target as string)
  );
  const skillsDir = join(repoRoot, INSTALLED_SKILLS_DIR);
  if (!existsSync(skillsDir)) return [];

  const swept: string[] = [];
  for (const entry of readdirSync(skillsDir)) {
    if (!entry.includes(INSTALLED_PROJECTION_MARKER)) continue; // only managed projections
    const rel = `${INSTALLED_SKILLS_DIR}/${entry}`;
    if (managed.has(rel)) continue; // still projected — keep
    rmSync(join(skillsDir, entry), { recursive: true, force: true });
    swept.push(rel);
  }
  return swept;
}

/**
 * Realize a projection plan on disk.
 *
 * `native`/`drop` actions are no-ops. `generate` is rewritten idempotently. A
 * `scaffold` is written only when absent (an existing, possibly hand-edited file
 * is left untouched). A `symlink` whose target is occupied by a *real* file or
 * directory is left intact and reported in `conflicts` — the engine never destroys
 * hand-authored content to make room for a projection.
 *
 * With `opts.sweepOrphans`, installed-plugin projections for plugins no longer in
 * the plan are removed (the drift-driven uninstall sweep). Pass it only for a full
 * (unfiltered) plan, or live projections for harnesses outside the filter would be
 * mistaken for orphans.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the projection plan to apply.
 * @param opts - optional flags; `sweepOrphans` enables the installed-orphan sweep.
 * @returns the realized actions, the symlink conflicts left intact, and any swept orphans.
 */
export function applyPlan(
  repoRoot: string,
  plan: ProjectionPlan,
  opts?: { sweepOrphans?: boolean }
): { applied: ProjectionAction[]; conflicts: ProjectionAction[]; swept: string[] } {
  const applied: ProjectionAction[] = [];
  const conflicts: ProjectionAction[] = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'symlink':
        if (applySymlink(repoRoot, action)) applied.push(action);
        else conflicts.push(action); // a real file/dir blocks the symlink — left intact
        break;
      case 'scaffold':
        applyScaffold(repoRoot, action);
        applied.push(action);
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

  const swept = opts?.sweepOrphans ? sweepInstalledOrphans(repoRoot, plan) : [];
  return { applied, conflicts, swept };
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
