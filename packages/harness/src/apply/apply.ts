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
import { AGENTS_SKILLS_DIR, INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';
import { GENERATED_HOOK_TARGETS } from '../generate/hooks.js';

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
 * A sweep candidate must be BOTH a real symlink AND carry the
 * `<pkg>__<skill>` marker — engine projections are always symlinks, so a
 * hand-authored *directory* (even one named `my__helper/`, which the authored
 * scan already skips) is never a candidate and is never removed. Among the
 * managed symlinks, any whose target is no longer in the current plan belongs to
 * an uninstalled plugin and is removed. This preserves the engine's guarantee
 * that it never destroys hand-authored content.
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
  const skillsDir = join(repoRoot, AGENTS_SKILLS_DIR);
  if (!existsSync(skillsDir)) return [];

  const swept: string[] = [];
  for (const entry of readdirSync(skillsDir)) {
    if (!entry.includes(INSTALLED_PROJECTION_MARKER)) continue; // looks like a managed projection…
    const abs = join(skillsDir, entry);
    if (!isSymlink(abs)) continue; // …but only ever sweep real engine symlinks, never a hand-authored dir/file
    const rel = `${AGENTS_SKILLS_DIR}/${entry}`;
    if (managed.has(rel)) continue; // still projected — keep
    rmSync(abs, { force: true }); // a symlink — remove the link, never recurse into a target
    swept.push(rel);
  }
  return swept;
}

/**
 * Prune orphaned engine-generated files (e.g. `.codex/hooks.json`).
 *
 * The engine wholly owns each path in {@link GENERATED_HOOK_TARGETS} for its
 * harness: the file is gitignored and rewritten from canonical sources on every
 * sync, so it never holds hand-authored content. When a plugin that contributed
 * the only Codex-mappable hook is uninstalled, the projector emits no `generate`
 * action for that path and the file is left stale on disk. This sweep removes any
 * such generated file the current plan no longer regenerates — the mirror of the
 * symlink orphan sweep in {@link sweepInstalledOrphans}.
 *
 * A path the plan still generates is kept (the apply pass rewrites it), so this
 * never races a live projection. A real file the engine does NOT own (anything
 * not in {@link GENERATED_HOOK_TARGETS}) is never touched.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths pruned.
 */
export function sweepGeneratedOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const regenerated = new Set(
    plan.actions.filter((a) => a.kind === 'generate' && a.target).map((a) => a.target as string)
  );

  const swept: string[] = [];
  for (const rel of GENERATED_HOOK_TARGETS) {
    if (regenerated.has(rel)) continue; // still generated by the current plan, keep (apply rewrites it)
    const abs = join(repoRoot, rel);
    if (!pathExists(abs)) continue; // nothing to prune
    // No symlink/content guard here (unlike the skill sweep above): every path in
    // GENERATED_HOOK_TARGETS is a wholly-engine-owned, gitignored plain file the
    // engine regenerates each sync, so deleting an un-regenerated one can never
    // clobber hand-authored content. This invariant is load-bearing: a shared or
    // partially-user-owned file (e.g. .gemini/settings.json) must NEVER be added
    // to GENERATED_HOOK_TARGETS (project it via a merge instead). If a future
    // target cannot guarantee sole ownership, add a content/marker guard here.
    rmSync(abs, { force: true });
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
 * With `opts.sweepOrphans`, projections for plugins no longer in the plan are
 * removed (the drift-driven uninstall sweep): orphaned installed-skill symlinks
 * AND orphaned engine-generated files (e.g. a stale `.codex/hooks.json` whose only
 * contributing plugin was uninstalled). Pass it only for a full (unfiltered) plan,
 * or live projections for harnesses outside the filter would be mistaken for
 * orphans.
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

  const swept = opts?.sweepOrphans
    ? [...sweepInstalledOrphans(repoRoot, plan), ...sweepGeneratedOrphans(repoRoot, plan)]
    : [];
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
