/**
 * Apply / check — realize a {@link ProjectionPlan} on disk, or diff against it.
 *
 * `applyPlan` materializes symlinks and generated files idempotently and scaffolds
 * pointers only when absent. It never destroys hand-authored content: an existing
 * scaffold is left untouched, a symlink target occupied by a *real* file or
 * directory surfaces as a `conflict` rather than being removed, and a generated
 * hook file the engine cannot prove it wrote is likewise a conflict, never a
 * rewrite and never a sweep (ownership lives in `generated-ownership.ts`).
 *
 * Symlinks AT a target are the shapes that need saying out loud, because the two
 * kinds mean opposite things. A **live** link at a generate target is a conflict:
 * reading and writing it both succeed, somewhere that is not this path
 * (`generate-occupants.ts`, which refuses a directory there for the same reason).
 * A **dead** link is nothing at all — so it is removed and replaced rather than
 * protected (`link-state.ts`), and one left behind by a skill that moved is swept
 * (`authored-orphans.ts`).
 *
 * `checkPlan` reports drift without touching disk, and never throws for what it
 * finds there. Both read deterministic bytes for `scaffold`/`generate` actions
 * from the projector via {@link getActionContent}.
 *
 * @module apply/apply
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DriftResult, ProjectionAction, ProjectionPlan } from '../plan/types.js';
import { requireActionContent } from '../plan/content-map.js';
import { AGENTS_SKILLS_DIR, INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';
import type { ClaudeHooksConfig } from '../generate/hooks.js';
import { HAND_WRITTEN_HOOKS_REASON, readFileIfPresent } from './generated-ownership.js';
import { findOrphanedAuthoredLinks, sweepAuthoredOrphans } from './authored-orphans.js';
import { isDanglingSymlink, isSymlink, listDir, pathExists } from './link-state.js';
import {
  applyGeneratedHookFile,
  findBlockedGenerateTargets,
  findLeftAloneGeneratedHookFiles,
  generatedHookOutcome,
  isGeneratedHookTarget,
  sweepGeneratedOrphans,
} from './generated-targets.js';
import { blockingGenerateOccupant } from './generate-occupants.js';
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

/**
 * True when a scaffold target already holds a pointer.
 *
 * A DEAD symlink does not count: there is nothing at the end of it, so the
 * pointer a harness reads is not there. Both `--check` (drift = absent) and
 * `--fix` ask this one question, so they cannot disagree about a broken link.
 */
function scaffoldPresent(absTarget: string): boolean {
  return pathExists(absTarget) && !isDanglingSymlink(absTarget);
}

/** The relative symlink text that points from `target` to `source`. */
function relativeLink(repoRoot: string, source: string, target: string): string {
  return relative(dirname(join(repoRoot, target)), join(repoRoot, source));
}

/**
 * The symlink type to request for a source path. Windows needs `'junction'` for
 * directory targets (which skill sources are) to avoid an EPERM without admin /
 * Developer Mode; POSIX ignores the type argument.
 *
 * The stat FOLLOWS the source deliberately. A skill source may itself be a
 * symlink into a shared directory, and `lstat` on that answers "not a directory"
 * — which asked Windows for a file link to a directory, the exact EPERM this
 * function exists to avoid. A dangling source still answers `undefined`.
 */
function symlinkType(repoRoot: string, source: string): 'junction' | 'file' | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    return statSync(join(repoRoot, source)).isDirectory() ? 'junction' : 'file';
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
  if (scaffoldPresent(absTarget)) return; // user owns it — never overwrite
  // Nothing but a dead link can be here now. It has to go before the write, or
  // `writeFileSync` follows it and creates the pointer wherever it points.
  rmSync(absTarget, { force: true });
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, requireActionContent(action));
}

/**
 * (Re)write a generated target deterministically.
 *
 * Two gates, in order. The target's SHAPE decides whether a write may happen at
 * this path at all — a directory or a live symlink is refused whoever owns it,
 * because the bytes would not land here. Only then does ownership decide: command
 * wrappers are wholly the engine's (their marker is the predicate, and the caller
 * has already checked it), so they are simply rewritten, while the per-harness
 * hooks files are not the engine's by path and go through
 * {@link applyGeneratedHookFile} and its sidecar rules instead.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param action - the `generate` action to realize.
 * @returns `undefined` when the target now matches the plan; the reason to report
 *   when something the engine may not write over occupies it — a conflict, left
 *   untouched.
 */
function applyGenerate(repoRoot: string, action: ProjectionAction): string | undefined {
  if (!action.target) throw new Error(`generate action for "${action.name}" is missing target`);
  const absTarget = join(repoRoot, action.target);

  // Shape first: a directory or a live link would send the write somewhere other
  // than this path, so neither is ever written over, whoever owns what is there.
  const shape = blockingGenerateOccupant(absTarget);
  if (shape !== undefined) return shape;

  // A dead link is the opposite case — nothing is there to own. Remove it, so
  // the file lands at this path instead of wherever the link pointed.
  if (isDanglingSymlink(absTarget)) rmSync(absTarget, { force: true });

  const content = requireActionContent(action);
  if (isGeneratedHookTarget(action.target)) {
    return applyGeneratedHookFile(absTarget, action.target, content)
      ? undefined
      : HAND_WRITTEN_HOOKS_REASON;
  }
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, content);
  return undefined;
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
  const managed = JSON.parse(requireActionContent(action)) as ClaudeHooksConfig;
  return mergeManagedHooks(join(repoRoot, action.target), managed);
}

/**
 * Sweep orphaned installed-plugin skill projections from `.agents/skills` and
 * `.claude/skills` (Codex and Claude Code both get namespaced symlinks now).
 *
 * A sweep candidate must be BOTH a real symlink AND carry the `__` infix. A
 * plain directory is never a candidate whatever it is called, because engine
 * projections are always symlinks — so a hand-authored `my__helper/` directory
 * is safe by being a directory, not by being invisible to the scanner. Among the
 * symlinks, any whose target is no longer in the current plan belongs to an
 * uninstalled plugin and is removed. This preserves the engine's guarantee that
 * it never destroys hand-authored content.
 *
 * The keep-set is every `symlink` target in the plan, of ANY provenance — not
 * just the installed ones. A person's own skill may be NAMED with a `__`, and it
 * then projects as an authored symlink at a path that looks managed; keeping
 * only installed targets meant one `applyPlan` created that link and deleted it
 * again on its way out (DOR-1844). What the sweep may TOUCH is still the narrow
 * `__`-plus-symlink test; only what it KEEPS is wide.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (every symlink target is kept).
 * @returns the repo-relative paths swept.
 */
export function sweepInstalledOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const managed = new Set(
    plan.actions.filter((a) => a.kind === 'symlink' && a.target).map((a) => a.target as string)
  );

  const swept: string[] = [];
  for (const dir of INSTALLED_SKILL_DIRS) {
    // `listDir`, not `existsSync` + `readdirSync`: a skills path that is a file
    // or unreadable has nothing to sweep, and must not abort the whole apply.
    const skillsDir = join(repoRoot, dir);
    for (const entry of listDir(skillsDir)) {
      if (!entry.includes(INSTALLED_PROJECTION_MARKER)) continue; // looks like a managed projection…
      const abs = join(skillsDir, entry);
      if (!isSymlink(abs)) continue; // …but only ever sweep real symlinks, never a hand-authored dir/file
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
 * Realize a projection plan on disk.
 *
 * `native`/`drop` actions are no-ops. `generate` is rewritten idempotently. A
 * `scaffold` is written only when absent (an existing, possibly hand-edited file
 * is left untouched). A `symlink` whose target is occupied by a *real* file or
 * directory is left intact and reported in `conflicts` — the engine never destroys
 * hand-authored content to make room for a projection. The per-harness hooks
 * files split that report in two, because the two cases mean different things: a
 * file the engine does not own at a target this plan WANTS to write is a
 * `conflict` (a projection was blocked, and the way out is in its reason), while
 * one at a target this plan writes nothing to is merely `leftAlone` — a
 * statement that the file is the person's, never a fault to fix.
 *
 * With `opts.sweepOrphans`, projections for plugins no longer in the plan are
 * removed (the drift-driven uninstall sweep): orphaned installed-skill symlinks,
 * dead `.claude/skills` links left by an authored skill somebody removed or
 * renamed, orphaned generated hook files the engine can prove it wrote (e.g. a
 * stale `.codex/hooks.json`, with its sidecar), orphaned command wrappers under
 * `.claude/commands/<pkg>/` and `.opencode/commands/`, and managed plugin hooks
 * left in `.claude/settings.local.json`. Pass it only for a full (unfiltered)
 * plan, or live projections for harnesses outside the filter would be mistaken
 * for orphans.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the projection plan to apply.
 * @param opts - optional flags; `sweepOrphans` enables the installed-orphan sweep.
 * @returns the realized actions, the blocked projections left intact, any swept
 *   orphans, and the generated-hook paths the engine stepped over.
 */
export function applyPlan(
  repoRoot: string,
  plan: ProjectionPlan,
  opts?: { sweepOrphans?: boolean }
): {
  applied: ProjectionAction[];
  conflicts: ProjectionAction[];
  swept: string[];
  leftAlone: string[];
} {
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
      case 'generate': {
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
        // Something DorkOS may not write over — left intact, with the way out.
        const blockedReason = applyGenerate(repoRoot, action);
        if (blockedReason === undefined) applied.push(action);
        else conflicts.push({ ...action, reason: blockedReason });
        break;
      }
      case 'merge':
        if (applyMerge(repoRoot, action)) applied.push(action);
        else conflicts.push(action); // corrupt user-owned target: aborted, left intact
        break;
      case 'native':
      case 'drop':
        break;
    }
  }

  // Somebody's own file at a target this plan never writes: said out loud, so a
  // repo whose hooks the engine is NOT projecting does not go quiet about it —
  // but kept out of `conflicts`, because nothing here was blocked.
  const leftAlone = findLeftAloneGeneratedHookFiles(repoRoot, plan);

  const swept = opts?.sweepOrphans
    ? [
        ...sweepInstalledOrphans(repoRoot, plan),
        ...sweepAuthoredOrphans(repoRoot, plan),
        ...sweepGeneratedOrphans(repoRoot, plan),
        ...sweepGeneratedCommandOrphans(repoRoot, plan),
        ...sweepOpencodeCommandOrphans(repoRoot, plan),
        ...sweepSettingsHooksOrphan(repoRoot, plan),
      ]
    : [];
  return { applied, conflicts, swept, leftAlone };
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
      return !action.target || !scaffoldPresent(join(repoRoot, action.target));
    case 'generate': {
      if (!action.target) return true;
      const absTarget = join(repoRoot, action.target);
      // A shape DorkOS may not write over is BLOCKED, not stale: re-running
      // fixes nothing, and saying "run --fix" about it would be a lie the person
      // then watches fail. `checkPlan` reports it in `blocked` instead.
      if (blockingGenerateOccupant(absTarget) !== undefined) return false;
      // Never a direct read: absent, an unreadable file and a DEAD LINK all
      // answer `undefined` here rather than throwing, and every one of them is
      // drift — nothing is there to read, so no ownership question arises, and
      // `--fix` clears the path and writes (AP-05). Asked BEFORE the content is
      // demanded, so an action carrying none reports drift rather than throwing.
      const onDisk = readFileIfPresent(absTarget);
      if (onDisk === undefined) return true;
      const content = requireActionContent(action);
      if (!isGeneratedHookTarget(action.target)) return onDisk !== content;
      // Drift is what `--fix` would CHANGE on disk — `adopt` counts, because
      // writing the missing sidecar is a change even though the file itself is
      // already right. `blocked` is a separate answer: somebody's own file is
      // not stale, it is theirs, and re-running fixes nothing about it.
      const outcome = generatedHookOutcome(absTarget, action.target, content, onDisk);
      return outcome === 'write' || outcome === 'adopt';
    }
    case 'merge': {
      if (!action.target) return true;
      const managed = JSON.parse(requireActionContent(action)) as ClaudeHooksConfig;
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
 * Four answers, deliberately kept apart: what is stale and a re-run would fix
 * (`drifted`), what a re-run would report as a conflict because somebody's own
 * file occupies a target the plan writes (`blocked`), what a re-run would sweep
 * because the skill it pointed at is gone (`orphans`), and what the engine simply
 * stepped over (`leftAlone`). The first three make a tree unclean — each is
 * something a `--fix` would change on disk — and the last does not: a person who
 * keeps their own `.codex/hooks.json` in a repo DorkOS projects no hooks to is
 * not carrying a fault.
 *
 * It never throws for what it finds on disk. A dead link, a directory where a
 * file belongs, an unreadable `.claude/skills` — each is an answer (drift,
 * blocked, or nothing at all), never an exception: this is the command a person
 * runs to be TOLD what is wrong with their tree.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the projection plan to check.
 * @returns the drifted actions, the blocked ones, the orphaned links, the paths
 *   left alone, and whether the tree is clean.
 */
export function checkPlan(repoRoot: string, plan: ProjectionPlan): DriftResult {
  const drifted = plan.actions.filter((action) => isDrifted(repoRoot, action));
  const blocked = findBlockedGenerateTargets(repoRoot, plan);
  const orphans = findOrphanedAuthoredLinks(repoRoot, plan);
  return {
    drifted,
    blocked,
    orphans,
    leftAlone: findLeftAloneGeneratedHookFiles(repoRoot, plan),
    clean: drifted.length === 0 && blocked.length === 0 && orphans.length === 0,
  };
}
