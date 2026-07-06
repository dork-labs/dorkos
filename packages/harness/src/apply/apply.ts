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
import { GENERATED_HOOK_TARGETS, type ClaudeHooksConfig } from '../generate/hooks.js';
import {
  CLAUDE_COMMANDS_DIR,
  CLAUDE_SKILLS_DIR,
  CLAUDE_SETTINGS_LOCAL_TARGET,
  GENERATED_COMMAND_MARKER,
  OPENCODE_COMMANDS_DIR,
} from '../plan/installed-projector.js';
import { mergeManagedHooks, sweepManagedHooks, managedHooksDrift } from './settings-hooks.js';

/** Skill projection dirs an installed-orphan sweep must scan (Codex + Claude Code). */
const INSTALLED_SKILL_DIRS = [AGENTS_SKILLS_DIR, CLAUDE_SKILLS_DIR] as const;

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
 * Merge the managed hooks a `merge` action carries INTO a user-owned settings
 * file, touching only the sentinel-tagged managed entries. Unlike
 * {@link applyGenerate}, the whole-file ownership model does NOT apply: the file
 * may hold the user's own settings, so a read-modify-write over just the managed
 * portion is required.
 *
 * @returns `true` when the merge landed; `false` when the target exists but is
 *   unparseable (corrupt or mid-write), in which case nothing was written and
 *   the action surfaces as a conflict, per the engine's stance that a real file
 *   blocking a managed target is a conflict.
 */
function applyMerge(repoRoot: string, action: ProjectionAction): boolean {
  if (!action.target) throw new Error(`merge action for "${action.name}" is missing target`);
  const managed = JSON.parse(requireContent(action)) as ClaudeHooksConfig;
  return mergeManagedHooks(join(repoRoot, action.target), managed);
}

/**
 * Sweep orphaned installed-plugin skill projections from `.agents/skills` and
 * `.claude/skills` (Codex and Claude Code both get namespaced symlinks now).
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
      .filter((a) => a.provenance === 'installed' && a.kind === 'symlink' && a.target)
      .map((a) => a.target as string)
  );

  const swept: string[] = [];
  for (const dir of INSTALLED_SKILL_DIRS) {
    const skillsDir = join(repoRoot, dir);
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir)) {
      if (!entry.includes(INSTALLED_PROJECTION_MARKER)) continue; // looks like a managed projection…
      const abs = join(skillsDir, entry);
      if (!isSymlink(abs)) continue; // …but only ever sweep real engine symlinks, never a hand-authored dir/file
      const rel = `${dir}/${entry}`;
      if (managed.has(rel)) continue; // still projected — keep
      rmSync(abs, { force: true }); // a symlink — remove the link, never recurse into a target
      swept.push(rel);
    }
  }
  return swept;
}

/**
 * Sweep orphaned engine-generated command wrappers from `.claude/commands/<pkg>/`.
 *
 * Wrappers (and the self-ignoring `.gitignore` beside them) each carry the
 * {@link GENERATED_COMMAND_MARKER}; that marker is the SOLE ownership predicate,
 * so a hand-authored command file (even one sharing a wrapper directory) is
 * never deleted. Any marked file the current plan no longer generates belongs to
 * an uninstalled plugin and is removed; a wrapper directory emptied by the sweep
 * is removed too.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths swept.
 */
export function sweepGeneratedCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const kept = new Set(
    plan.actions
      .filter((a) => a.kind === 'generate' && a.target?.startsWith(`${CLAUDE_COMMANDS_DIR}/`))
      .map((a) => a.target as string)
  );
  const commandsDir = join(repoRoot, CLAUDE_COMMANDS_DIR);
  if (!existsSync(commandsDir)) return [];

  const swept: string[] = [];
  for (const sub of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subAbs = join(commandsDir, sub.name);
    for (const file of readdirSync(subAbs)) {
      const rel = `${CLAUDE_COMMANDS_DIR}/${sub.name}/${file}`;
      if (kept.has(rel)) continue; // still projected: keep (apply rewrites it)
      const abs = join(subAbs, file);
      if (!isEngineGeneratedCommand(abs)) continue; // authored file (or nested dir): never touch
      rmSync(abs, { force: true });
      swept.push(rel);
    }
    // A wrapper dir emptied by the sweep (all engine files gone) is removed too.
    if (existsSync(subAbs) && readdirSync(subAbs).length === 0) {
      rmSync(subAbs, { recursive: true, force: true });
    }
  }
  return swept;
}

/**
 * Sweep orphaned engine-generated OpenCode command wrappers from the flat
 * `.opencode/commands/` dir.
 *
 * The dir is SHARED: authored commands may live beside the engine wrappers, so
 * the {@link GENERATED_COMMAND_MARKER} is again the SOLE ownership predicate — a
 * marker-less authored file (including a hand-authored `.gitignore`) is never
 * touched. Any marked top-level file the current plan no longer generates (the
 * `.gitignore` itself included, once the last wrapper is gone) is removed. The
 * dir is never deleted, since it may still hold authored commands.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths swept.
 */
export function sweepOpencodeCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const kept = new Set(
    plan.actions
      .filter((a) => a.kind === 'generate' && a.target?.startsWith(`${OPENCODE_COMMANDS_DIR}/`))
      .map((a) => a.target as string)
  );
  const commandsDir = join(repoRoot, OPENCODE_COMMANDS_DIR);
  if (!existsSync(commandsDir)) return [];

  const swept: string[] = [];
  for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // flat: only top-level engine wrapper files (and the .gitignore)
    const rel = `${OPENCODE_COMMANDS_DIR}/${entry.name}`;
    if (kept.has(rel)) continue; // still projected: keep (apply rewrites it)
    const abs = join(commandsDir, entry.name);
    if (!isEngineGeneratedCommand(abs)) continue; // authored file: never touch
    rmSync(abs, { force: true });
    swept.push(rel);
  }
  return swept;
}

/** True when a file carries the engine's generated-command marker (never a directory). */
function isEngineGeneratedCommand(abs: string): boolean {
  try {
    return readFileSync(abs, 'utf8').includes(GENERATED_COMMAND_MARKER);
  } catch {
    return false; // unreadable, or a directory (EISDIR): not an engine wrapper file
  }
}

/**
 * Wrapper target dirs (`.claude/commands/<pkg>/`) the plan wants to generate
 * into but that already hold NON-engine content: a user's authored command
 * namespace sharing a plugin's name. Writing wrappers (and especially the
 * self-ignoring `.gitignore`) into such a dir would silently co-opt authored
 * files out of git, so every wrapper generate targeting a blocked dir surfaces
 * as a conflict and nothing is written there.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its wrapper targets are checked).
 * @returns the repo-relative wrapper dirs that are blocked by authored content.
 */
function findBlockedWrapperDirs(repoRoot: string, plan: ProjectionPlan): Set<string> {
  const wrapperDirs = new Set(
    plan.actions
      .filter((a) => a.kind === 'generate' && a.target?.startsWith(`${CLAUDE_COMMANDS_DIR}/`))
      .map((a) => dirname(a.target as string))
  );

  const blocked = new Set<string>();
  for (const relDir of wrapperDirs) {
    const abs = join(repoRoot, relDir);
    if (!existsSync(abs)) continue; // fresh dir: the engine will own it
    const hasForeignContent = readdirSync(abs).some(
      (entry) => !isEngineGeneratedCommand(join(abs, entry))
    );
    if (hasForeignContent) blocked.add(relDir);
  }
  return blocked;
}

/**
 * OpenCode command targets (`.opencode/commands/<file>`) the plan wants to
 * generate but that already exist on disk as NON-engine (marker-less) files: a
 * user's authored command or a hand-authored `.gitignore` at the same path.
 *
 * Unlike the Claude wrapper dir (which the engine owns wholesale, per plugin),
 * the flat OpenCode command dir is SHARED, so the block is per-FILE, not per-dir:
 * only the exact colliding file is a conflict, and the engine's other wrappers
 * still project. Writing over the authored file would silently co-opt it, so it
 * surfaces as a conflict and nothing is written there.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its OpenCode command targets are checked).
 * @returns the repo-relative OpenCode command targets blocked by authored content.
 */
function findBlockedOpencodeCommandFiles(repoRoot: string, plan: ProjectionPlan): Set<string> {
  const blocked = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind !== 'generate') continue;
    const target = action.target;
    if (!target?.startsWith(`${OPENCODE_COMMANDS_DIR}/`)) continue;
    const abs = join(repoRoot, target);
    if (pathExists(abs) && !isEngineGeneratedCommand(abs)) blocked.add(target);
  }
  return blocked;
}

/**
 * Sweep managed installed-plugin hooks out of `.claude/settings.local.json` when
 * the plan no longer merges any (the last hook-bearing plugin was uninstalled).
 * When the plan DOES carry a merge action, that action's apply already
 * reconciles the managed entries, so this is a no-op to avoid a double write.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns the repo-relative path swept (one entry) or empty.
 */
export function sweepSettingsHooksOrphan(repoRoot: string, plan: ProjectionPlan): string[] {
  const hasMerge = plan.actions.some(
    (a) => a.kind === 'merge' && a.target === CLAUDE_SETTINGS_LOCAL_TARGET
  );
  if (hasMerge) return [];
  const absTarget = join(repoRoot, CLAUDE_SETTINGS_LOCAL_TARGET);
  return sweepManagedHooks(absTarget) ? [CLAUDE_SETTINGS_LOCAL_TARGET] : [];
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
 * removed (the drift-driven uninstall sweep): orphaned installed-skill symlinks,
 * orphaned engine-generated files (e.g. a stale `.codex/hooks.json`), orphaned
 * command wrappers under `.claude/commands/<pkg>/` and `.opencode/commands/`, and
 * managed plugin hooks left in `.claude/settings.local.json`. Pass it only for a
 * full (unfiltered) plan, or live projections for harnesses outside the filter
 * would be mistaken for orphans.
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
  const blockedWrapperDirs = findBlockedWrapperDirs(repoRoot, plan);
  const blockedOpencodeCommandFiles = findBlockedOpencodeCommandFiles(repoRoot, plan);

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
        // Hand-authored content at a wrapper target blocks that projection: an
        // authored Claude wrapper DIR (whole plugin) or an authored OpenCode
        // command FILE (that one file). The engine never co-opts authored content.
        if (
          action.target &&
          (blockedWrapperDirs.has(dirname(action.target)) ||
            blockedOpencodeCommandFiles.has(action.target))
        ) {
          conflicts.push(action);
          break;
        }
        applyGenerate(repoRoot, action);
        applied.push(action);
        break;
      case 'merge':
        if (applyMerge(repoRoot, action)) applied.push(action);
        else conflicts.push(action); // corrupt user-owned target: aborted, left intact
        break;
      case 'native':
      case 'drop':
        break;
    }
  }

  const swept = opts?.sweepOrphans
    ? [
        ...sweepInstalledOrphans(repoRoot, plan),
        ...sweepGeneratedOrphans(repoRoot, plan),
        ...sweepGeneratedCommandOrphans(repoRoot, plan),
        ...sweepOpencodeCommandOrphans(repoRoot, plan),
        ...sweepSettingsHooksOrphan(repoRoot, plan),
      ]
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
    case 'merge': {
      if (!action.target) return true;
      const managed = JSON.parse(requireContent(action)) as ClaudeHooksConfig;
      return managedHooksDrift(join(repoRoot, action.target), managed);
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
