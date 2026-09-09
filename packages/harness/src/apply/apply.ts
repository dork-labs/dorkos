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
 * ## What a concurrent reader can see
 *
 * Every FILE this stage writes goes through `writeFileAtomic`, so a harness
 * reading `.codex/hooks.json` while a sync rewrites it gets the whole old file
 * or the whole new one — never an empty or half-written config (AP-10). That
 * covers scaffolds, generated files, the generated hooks files, their ownership
 * sidecars, and the managed-hook merge.
 *
 * A repaired SYMLINK is the one exception, and it is left as it is. Replacing a
 * stale managed link is `rmSync` then `symlinkSync`, so for the microseconds
 * between them the link is absent and a harness enumerating `.claude/skills`
 * would list one skill fewer. It is not worth closing: the removal happens only
 * when the link TEXT is already wrong (a source that moved), so the reader in
 * that window would otherwise have followed a link to the wrong place, and the
 * next scan — the same session's next skill lookup — sees the repaired link.
 * Making it atomic means creating the link at a temp name and renaming it over
 * the target, which on Windows means renaming a junction; that trade is not one
 * this engine has evidence for yet.
 *
 * @module apply/apply
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DriftResult, ProjectionAction, ProjectionPlan, SweptPath } from '../plan/types.js';
import { explainSweep } from './sweep-reasons.js';
import { requireActionContent } from '../plan/content-map.js';
import { AGENTS_SKILLS_DIR, INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';
import type { ClaudeHooksConfig } from '../generate/hooks.js';
import { isAtomicTempName, isStaleAtomicTemp, writeFileAtomic } from './atomic-write.js';
import { HAND_WRITTEN_HOOKS_REASON, readFileIfPresent } from './generated-ownership.js';
import { findOrphanedAuthoredLinks, sweepAuthoredOrphans } from './authored-orphans.js';
import {
  isDanglingSymlink,
  isSymlink,
  listDir,
  listDirEntries,
  occupantKind,
  pathExists,
  tryListDir,
} from './link-state.js';
import { blockingSymlinkOccupant, linkCheckFor, linkMatchesPlan } from './symlink-occupants.js';
import {
  applyGeneratedHookFile,
  findBlockedGenerateTargets,
  findGeneratedOrphans,
  findLeftAloneGeneratedHookFiles,
  generatedHookOutcome,
  isGeneratedHookTarget,
  sweepGeneratedOrphans,
} from './generated-targets.js';
import { blockingGenerateOccupant } from './generate-occupants.js';
import { findBlockedWritePaths, findUnwritableTargets } from './write-path-occupants.js';
import {
  CLAUDE_COMMANDS_DIR,
  CLAUDE_SKILLS_DIR,
  CLAUDE_SETTINGS_LOCAL_TARGET,
  GENERATED_COMMAND_MARKER,
  OPENCODE_COMMANDS_DIR,
} from '../plan/installed-projector.js';
import {
  hasManagedHooks,
  mergeManagedHooks,
  sweepManagedHooks,
  managedHooksDrift,
} from './settings-hooks.js';

/** Skill projection dirs an installed-orphan sweep must scan (Codex + Claude Code). */
const INSTALLED_SKILL_DIRS = [AGENTS_SKILLS_DIR, CLAUDE_SKILLS_DIR] as const;

/**
 * Whether any skill SOURCE folder was unreadable when this plan was built — the
 * one condition under which both skill-link sweeps stand down.
 *
 * The sweeps read the plan as their keep-set: a link the plan does not name is
 * an orphan. That inference holds only while the plan is a complete answer, and
 * a folder nobody could list yields the same empty result an empty folder does.
 * So `chmod 000 .agents/skills` made every authored projection look orphaned and
 * `applyPlan` deleted `.claude/skills/*`; an unreadable package `skills/` took
 * all four of that package's links the same way. Both measured on the built dist
 * (DOR-1882), and both silent — the crash they replaced at least removed nothing.
 *
 * ONE flag suppresses BOTH sweeps, rather than matching each unreadable folder
 * to the links it would have named. The authored root and a package's `skills/`
 * feed one keep-set, the cost of over-suppressing is a dead link left lying
 * about until the folder is readable again, and the cost of under-suppressing is
 * somebody's projections deleted. A rule that cannot be got subtly wrong is
 * worth more here than a tidier tree.
 *
 * The other four sweeps are untouched: none of them reads a skill source. The
 * generated-hook and command-wrapper sweeps own their targets by marker or
 * sidecar, and the settings sweep by sentinel.
 *
 * @param plan - the plan whose keep-set is in question.
 * @returns `true` when at least one skill root could not be listed.
 */
function skillSourcesUnreadable(plan: ProjectionPlan): boolean {
  return (plan.unreadableSkillRoots?.length ?? 0) > 0;
}

/**
 * How this platform decides whether a link on disk is the link the plan wants.
 *
 * Resolved once at module scope: it is a property of the running platform, not
 * of any one path, and `--check` and `--fix` must ask the same question.
 */
const LINK_CHECK = linkCheckFor(process.platform);

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
 * How many times {@link applySymlink} will look again after another writer beat
 * it to the target.
 *
 * Three, not one: the loop only repeats when the path CHANGED under it, so each
 * repeat is evidence of a real concurrent writer rather than of a wait. Two
 * writers applying the same plan settle on the first repeat; the third is slack
 * for a third writer, and the answer after that is whatever is actually there.
 */
const SYMLINK_ATTEMPTS = 3;

/**
 * Create or repair a relative symlink for a `symlink` action.
 *
 * Every step here is a check followed by an act, and another process applying
 * the same plan can land between the two: `symlinkSync` then throws EEXIST and
 * takes the whole apply down with it — measured, in `__tests__/journeys/
 * j12-two-writers.test.ts`, which reproduced it on the first run of two writers
 * on one repo. There is no atomic create-or-adopt for a link, so the answer is
 * to look again: an EEXIST means somebody put something here, and what they put
 * decides the outcome exactly as it would have a moment earlier. Two writers
 * applying the same plan therefore BOTH report the link applied, which is true —
 * it is there, and it is theirs.
 *
 * Unlike the file writes, the replacement of a STALE link is still not atomic:
 * the old link is removed before the new one is created, so a harness listing
 * `.claude/skills` in that window sees one skill fewer. It happens only when the
 * link text is already wrong (a source that moved), so the reader in that window
 * would otherwise have followed a link to the wrong place, and the next lookup
 * finds the repaired link. Closing it means creating the link at a temp name and
 * renaming it over the target, which on Windows means renaming a junction — a
 * trade with no evidence behind it yet.
 *
 * @returns `undefined` when the symlink now matches the plan; the one-line reason
 *   to report when a *real* (non-symlink) file or directory occupies the target —
 *   a conflict that is left untouched rather than destroyed, exactly like
 *   {@link applyScaffold}. The reason comes from the same predicate `checkPlan`
 *   reads, so the two modes can never disagree about a path neither may touch.
 *   Exhausting {@link SYMLINK_ATTEMPTS} — three consecutive lost races against a
 *   writer wanting DIFFERENT link text at one path — answers `undefined` too,
 *   and deliberately invents no reason for it: nothing is blocking the path, a
 *   re-run does fix it, and `isDrifted` reports exactly that. So the tree is
 *   never called clean on the strength of it, which is the property that matters.
 */
function applySymlink(repoRoot: string, action: ProjectionAction): string | undefined {
  if (!action.source || !action.target) {
    throw new Error(`symlink action for "${action.name}" is missing source/target`);
  }
  const absTarget = join(repoRoot, action.target);
  const linkText = relativeLink(repoRoot, action.source, action.target);

  const absSource = join(repoRoot, action.source);
  for (let attempt = 0; attempt < SYMLINK_ATTEMPTS; attempt++) {
    if (pathExists(absTarget)) {
      // A real file/dir — never destroy hand-authored content, and say what it is.
      const blocked = blockingSymlinkOccupant(absTarget, linkText);
      if (blocked !== undefined) return blocked;
      if (linkMatchesPlan(absTarget, absSource, linkText, LINK_CHECK)) {
        return undefined; // already the correct managed link
      }
      rmSync(absTarget, { force: true }); // a stale *managed* symlink — safe to replace
    }
    mkdirSync(dirname(absTarget), { recursive: true });
    try {
      symlinkSync(linkText, absTarget, symlinkType(repoRoot, action.source));
      return undefined;
    } catch (err) {
      // Anything but "somebody got here first" is a real failure to report.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  // Out of attempts: answer for what is actually there, through the same two
  // predicates, so this can still only ever report a real occupant.
  return blockingSymlinkOccupant(absTarget, linkText);
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
  // Nothing but a dead link can be here now, and the atomic write replaces the
  // directory entry rather than following it — so the pointer lands at THIS path
  // instead of wherever the dead link pointed, with no removal step to leave a
  // gap in (`atomic-write.ts`).
  writeFileAtomic(absTarget, requireActionContent(action));
}

/**
 * Realize a generated target deterministically, writing only on a difference.
 *
 * Three gates, in order. The target's SHAPE decides whether a write may happen at
 * this path at all — a directory or a live symlink is refused whoever owns it,
 * because the bytes would not land here. Then ownership: command wrappers are
 * wholly the engine's (their marker is the predicate, and the caller has already
 * checked it), while the per-harness hooks files are not the engine's by path and
 * go through {@link applyGeneratedHookFile} and its sidecar rules instead. Last,
 * the BYTES: a wrapper already holding exactly what the plan says is realized,
 * and this returns without touching it.
 *
 * **That last gate is load-bearing, and it was missing.** This function used to
 * rewrite every wrapper on every sync, which made `isDrifted` — the predicate
 * both modes use to decide which actions are "about to write", and so which
 * folders to ask about permission — a claim about the wrong set. A fully synced
 * repository with `chmod 0555` on one wrapper directory therefore had `--check`
 * report NO DRIFT and exit 0, while the `--fix` beside it died with EACCES out
 * of `writeFileAtomic` (measured on the built dist, DOR-1882 re-review). Worse,
 * the file it died on was the one the plan had nothing to change about: the
 * self-ignoring `.gitignore`, byte-correct and never probed, thrown on before
 * the six sweeps ran and with a staged orphan still on disk.
 *
 * The hooks-file branch has always worked this way ({@link generatedHookOutcome}
 * answers `unchanged`), and for the second reason too: these paths are watched,
 * and a write that changes nothing is still a change event for whoever is
 * watching. Command wrappers now match.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param action - the `generate` action to realize.
 * @returns `undefined` when the target now matches the plan — whether this call
 *   wrote it or found it already right, which is what `applied` has always meant
 *   for a link that already pointed where the plan said; the reason to report
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

  // A dead link is the opposite case — nothing is there to own, and the atomic
  // write replaces the entry rather than following it, so the file lands at this
  // path instead of wherever the link pointed.
  const content = requireActionContent(action);
  if (isGeneratedHookTarget(action.target)) {
    return applyGeneratedHookFile(absTarget, action.target, content)
      ? undefined
      : HAND_WRITTEN_HOOKS_REASON;
  }
  // Already exactly these bytes: realized, and nothing to do. Never a direct
  // read — absent, an unreadable file and a dead link all answer `undefined`
  // here rather than throwing, and every one of them is a write.
  if (readFileIfPresent(absTarget) === content) return undefined;
  writeFileAtomic(absTarget, content);
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
 * Find the orphaned installed-plugin skill projections in `.agents/skills` and
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
 * @returns the repo-relative paths a sweep would remove.
 */
export function findInstalledOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  // A plan built over a skill folder nobody could read is not evidence of what
  // is installed — see `skillSourcesUnreadable`.
  if (skillSourcesUnreadable(plan)) return [];
  const managed = new Set(
    plan.actions.filter((a) => a.kind === 'symlink' && a.target).map((a) => a.target as string)
  );

  const orphans: string[] = [];
  for (const dir of INSTALLED_SKILL_DIRS) {
    // `listDir`, not `existsSync` + `readdirSync`: a skills path that is a file
    // or unreadable has nothing to sweep, and must not abort the whole apply —
    // nor throw out of the `--check` that reads the same scanner.
    const skillsDir = join(repoRoot, dir);
    for (const entry of listDir(skillsDir)) {
      if (!entry.includes(INSTALLED_PROJECTION_MARKER)) continue; // looks like a managed projection…
      const abs = join(skillsDir, entry);
      if (!isSymlink(abs)) continue; // …but only ever sweep real symlinks, never a hand-authored dir/file
      const rel = `${dir}/${entry}`;
      if (managed.has(rel)) continue; // still projected — keep
      orphans.push(rel);
    }
  }
  return orphans;
}

/**
 * Remove the orphaned installed-plugin skill projections
 * {@link findInstalledOrphans} names.
 *
 * Every path it hands back is a symlink, so the link is removed and nothing at
 * the other end of it is ever touched.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (every symlink target is kept).
 * @returns the repo-relative paths swept.
 */
export function sweepInstalledOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const orphans = findInstalledOrphans(repoRoot, plan);
  for (const rel of orphans) rmSync(join(repoRoot, rel), { force: true });
  return orphans;
}

/**
 * Find the orphaned engine-generated command wrappers under
 * `.claude/commands/<pkg>/`.
 *
 * Wrappers (and the self-ignoring `.gitignore` beside them) each carry the
 * {@link GENERATED_COMMAND_MARKER}; that marker is the SOLE ownership predicate,
 * so a hand-authored command file (even one sharing a wrapper directory) is
 * never deleted. Any marked file the current plan no longer generates belongs to
 * an uninstalled plugin.
 *
 * A wrapper directory the sweep empties is removed too, but it is not listed
 * here: what a person is warned about — and what `swept` reports — is the files
 * that go, and a directory that only existed to hold them is bookkeeping.
 *
 * This and `.opencode/commands/` are the only directories the engine enumerates
 * by wildcard, which is why they are the only two where a stranded atomic-write
 * temp is debris to be swept rather than an inert dotfile (`atomic-write.ts`).
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths a sweep would remove.
 */
export function findGeneratedCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const kept = new Set(
    plan.actions
      .filter((a) => a.kind === 'generate' && a.target?.startsWith(`${CLAUDE_COMMANDS_DIR}/`))
      .map((a) => a.target as string)
  );
  // `listDirEntries`/`listDir`, never a bare `readdirSync`: this walk answers
  // `--check` as well as `--fix` now, and a stray FILE at `.claude/commands`
  // (ENOTDIR) or one nobody may read (EACCES) must be nothing to list rather
  // than an exception thrown out of a report (see `link-state.ts`).
  const commandsDir = join(repoRoot, CLAUDE_COMMANDS_DIR);

  const orphans: string[] = [];
  for (const sub of listDirEntries(commandsDir)) {
    if (!sub.isDirectory()) continue;
    const subAbs = join(commandsDir, sub.name);
    for (const file of listDir(subAbs)) {
      const rel = `${CLAUDE_COMMANDS_DIR}/${sub.name}/${file}`;
      const abs = join(subAbs, file);
      // A temp file is another writer's in-flight write, and it carries the
      // marker this sweep owns things by. Age is the only thing that can tell a
      // stranded one from a live one, so age is what decides — and a stale one
      // is named in the preview too, because a `--fix` really does take it.
      if (isAtomicTempName(file)) {
        if (isStaleAtomicTemp(abs)) orphans.push(rel);
        continue;
      }
      if (kept.has(rel)) continue; // still projected: keep (apply rewrites it)
      if (!isEngineGeneratedCommand(abs)) continue; // authored file (or nested dir): never touch
      orphans.push(rel);
    }
  }
  return orphans;
}

/**
 * Remove the orphaned Claude command wrappers {@link findGeneratedCommandOrphans}
 * names, then remove any wrapper directory left empty.
 *
 * The directory pass runs over every `.claude/commands/<pkg>/` rather than only
 * the ones this sweep emptied, which is what the single-pass version did too: a
 * wrapper dir with nothing in it holds no command for anybody, whoever emptied it.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths swept (files only — see the finder).
 */
export function sweepGeneratedCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const orphans = findGeneratedCommandOrphans(repoRoot, plan);
  for (const rel of orphans) rmSync(join(repoRoot, rel), { force: true });

  // The same throw-safe lister as the finder for the OUTER walk, so the sweep
  // can never walk a shape the preview declined to walk.
  //
  // The inner question is a different one and gets a different call. This is the
  // only place in the engine that deletes on an EMPTY listing, and `listDir`
  // answers `[]` both for a directory with nothing in it and for one nobody
  // could read — so it would have read "could not look" as "nothing is here" and
  // removed a directory whose contents it never saw. `tryListDir` keeps the two
  // apart, and only a real empty listing is a wrapper dir worth tidying away.
  // (Measured before: `rmSync` on a mode-000 dir does not quietly decline, it
  // throws EACCES out of the middle of an apply.)
  const commandsDir = join(repoRoot, CLAUDE_COMMANDS_DIR);
  for (const sub of listDirEntries(commandsDir)) {
    if (!sub.isDirectory()) continue;
    const subAbs = join(commandsDir, sub.name);
    if (tryListDir(subAbs)?.length === 0) rmSync(subAbs, { recursive: true, force: true });
  }
  return orphans;
}

/**
 * Find the orphaned engine-generated OpenCode command wrappers in the flat
 * `.opencode/commands/` dir.
 *
 * The dir is SHARED: authored commands may live beside the engine wrappers, so
 * the {@link GENERATED_COMMAND_MARKER} is again the SOLE ownership predicate — a
 * marker-less authored file (including a hand-authored `.gitignore`) is never
 * touched. Any marked top-level file the current plan no longer generates (the
 * `.gitignore` itself included, once the last wrapper is gone) is an orphan. The
 * dir itself is never deleted, since it may still hold authored commands.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths a sweep would remove.
 */
export function findOpencodeCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const kept = new Set(
    plan.actions
      .filter((a) => a.kind === 'generate' && a.target?.startsWith(`${OPENCODE_COMMANDS_DIR}/`))
      .map((a) => a.target as string)
  );
  // Throw-safe for the same reason the Claude walk is: a stray file at this
  // path, or a directory nobody may read, is nothing to list and never an
  // exception raised out of a `--check`.
  const commandsDir = join(repoRoot, OPENCODE_COMMANDS_DIR);

  const orphans: string[] = [];
  for (const entry of listDirEntries(commandsDir)) {
    if (!entry.isFile()) continue; // flat: only top-level engine wrapper files (and the .gitignore)
    const rel = `${OPENCODE_COMMANDS_DIR}/${entry.name}`;
    const abs = join(commandsDir, entry.name);
    // Same rule as the Claude wrapper dir: a live temp is untouchable, a
    // stranded one is debris.
    if (isAtomicTempName(entry.name)) {
      if (isStaleAtomicTemp(abs)) orphans.push(rel);
      continue;
    }
    if (kept.has(rel)) continue; // still projected: keep (apply rewrites it)
    if (!isEngineGeneratedCommand(abs)) continue; // authored file: never touch
    orphans.push(rel);
  }
  return orphans;
}

/**
 * Remove the orphaned OpenCode command wrappers
 * {@link findOpencodeCommandOrphans} names.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its generate targets are kept).
 * @returns the repo-relative paths swept.
 */
export function sweepOpencodeCommandOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const orphans = findOpencodeCommandOrphans(repoRoot, plan);
  for (const rel of orphans) rmSync(join(repoRoot, rel), { force: true });
  return orphans;
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
    // `listDir`, never `existsSync` + `readdirSync`: a wrapper path that is a
    // FILE or one nobody may read said "yes, something is here" to the guard and
    // then threw ENOTDIR/EACCES out of the middle of the apply — before a single
    // action had run, so not one projection landed (DOR-1882). Nothing listable
    // holds no foreign content; the write path pre-pass has already blocked that
    // package's wrappers with a reason naming the folder.
    const abs = join(repoRoot, relDir);
    const hasForeignContent = listDir(abs).some((entry) => isForeign(join(abs, entry), entry));
    if (hasForeignContent) blocked.add(relDir);
  }
  return blocked;
}

/**
 * Whether one entry of a wrapper directory is somebody else's content — the
 * question that decides whether the whole directory is blocked.
 *
 * Two answers here are NOT "foreign", and both were bugs before DOR-1854's
 * review found them:
 *
 * - **A temp file.** Another process's in-flight write, carrying the very
 *   marker this predicate reads. It is not content and it will not be there in
 *   a moment.
 * - **An entry that has gone.** `readdirSync` hands back a snapshot, and a
 *   concurrent writer renames its temp onto the target between the listing and
 *   the read. The read then throws ENOENT, which
 *   {@link isEngineGeneratedCommand} cannot tell from an unreadable authored
 *   file — so it answered "foreign" and reported the engine's OWN wrapper
 *   directory, all of it, as a conflict left untouched.
 *
 * @param abs - absolute path of the entry.
 * @param name - its base name.
 * @returns `true` only when something that is really there is really not ours.
 */
function isForeign(abs: string, name: string): boolean {
  if (isAtomicTempName(name)) return false;
  if (!existsSync(abs)) return false; // renamed away mid-scan: nothing is there to own
  return !isEngineGeneratedCommand(abs);
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
 * Whether a sweep would take managed installed-plugin hooks out of
 * `.claude/settings.local.json` — because the plan no longer merges any (the
 * last hook-bearing plugin was uninstalled) and some are still in the file.
 *
 * When the plan DOES carry a merge action, that action's apply already
 * reconciles the managed entries, so there is nothing to sweep and this is
 * empty — which is also why a double write never happens.
 *
 * The one path this can name is the settings file itself, and only its managed
 * hook groups are removed: the file survives with every user-owned key intact.
 * It is listed alongside paths that really do disappear because it is a path a
 * sync CHANGES without being asked, which is what a person needs told.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns the repo-relative path a sweep would rewrite (one entry) or empty.
 */
export function findSettingsHooksOrphan(repoRoot: string, plan: ProjectionPlan): string[] {
  const hasMerge = plan.actions.some(
    (a) => a.kind === 'merge' && a.target === CLAUDE_SETTINGS_LOCAL_TARGET
  );
  if (hasMerge) return [];
  return hasManagedHooks(join(repoRoot, CLAUDE_SETTINGS_LOCAL_TARGET))
    ? [CLAUDE_SETTINGS_LOCAL_TARGET]
    : [];
}

/**
 * Strip the managed installed-plugin hooks {@link findSettingsHooksOrphan}
 * found, leaving every user-owned hook and key in place.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns the repo-relative path swept (one entry) or empty.
 */
export function sweepSettingsHooksOrphan(repoRoot: string, plan: ProjectionPlan): string[] {
  const orphans = findSettingsHooksOrphan(repoRoot, plan);
  if (orphans.length > 0) sweepManagedHooks(join(repoRoot, CLAUDE_SETTINGS_LOCAL_TARGET));
  return orphans;
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
 * for orphans — `projectWithConsent` refuses that combination outright.
 *
 * Every one of those six sweeps has a `find*` half, and `swept` holds exactly
 * the paths {@link checkPlan} named in `orphans` a moment earlier — the same
 * set, listed in the order the sweeps ran rather than sorted. So a `--check` is
 * silent about nothing a `--fix` removes (DOR-1889).
 *
 * `removals` is that same list with the reason each path goes beside it
 * (DOR-1906) — six sweeps, six different facts, and a bare list of paths says
 * none of them. `swept` stays a `string[]` because that is what the equality
 * contract with `sweepPreview` is written against and what every existing caller
 * reads; the two are the same paths in the same order, which
 * `__tests__/orphan-preview.test.ts` asserts.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the projection plan to apply.
 * @param opts - optional flags; `sweepOrphans` enables the installed-orphan sweep.
 * `applied` here means REALIZED, not changed: a link already pointing where the
 * plan says is reported alongside one this run created, because a project sync's
 * receipt is a summary of the projection. `applyGlobalPlan` deliberately means
 * the other thing — see its own TSDoc for why a run against somebody's home
 * directory reports what it changed instead.
 *
 * @returns the realized actions, the blocked projections left intact, any swept
 *   orphans (bare and with their reasons), and the generated-hook paths the
 *   engine stepped over.
 * @throws When `sweepOrphans` is asked for on a plan narrowed to one harness —
 *   the combination deletes every other harness's LIVE projection, and the
 *   engine refuses it here rather than trusting each caller to remember.
 */
export function applyPlan(
  repoRoot: string,
  plan: ProjectionPlan,
  opts?: { sweepOrphans?: boolean }
): {
  applied: ProjectionAction[];
  conflicts: ProjectionAction[];
  swept: string[];
  removals: SweptPath[];
  leftAlone: string[];
} {
  // `checkPlan` withholds orphans for a narrowed plan; this is the same rule on
  // the writing side, and it has to THROW rather than skip the sweep, because a
  // caller that asked for a sweep and silently got none would leave the orphans
  // it meant to remove. `projectWithConsent` refuses the same pair one layer up;
  // this is the backstop for every other caller (DOR-1889).
  if (opts?.sweepOrphans && plan.narrowedTo !== undefined) {
    throw new Error(
      'applyPlan: sweepOrphans cannot run on a plan narrowed to one harness — ' +
        'the sweep would delete every other harness’s live projection.'
    );
  }

  const applied: ProjectionAction[] = [];
  const conflicts: ProjectionAction[] = [];
  // FIRST, and pure: which actions cannot reach their target because a folder on
  // the way is a file, an unfollowable link, or unreadable. Computed over the
  // whole plan before anything is written, so a hostile folder costs exactly the
  // projections that go through it rather than everything after it in the loop —
  // the difference between a blocked projection and a half-applied tree with the
  // six sweeps never reached (`write-path-occupants.ts`, DOR-1882).
  const blockedWritePaths = findBlockedWritePaths(repoRoot, plan);
  // And the permission half, asked only of the actions that are really about to
  // write — `isDrifted` is what "really about to write" means, and `checkPlan`
  // scopes it with the same predicate so the two modes name the same paths.
  const unwritableTargets = findUnwritableTargets(
    repoRoot,
    plan.actions.filter(
      (action) =>
        !(action.target !== undefined && blockedWritePaths.has(action.target)) &&
        isDrifted(repoRoot, action)
    )
  );
  const blockedWrapperDirs = findBlockedWrapperDirs(repoRoot, plan);
  const blockedOpencodeCommandFiles = findBlockedOpencodeCommandFiles(repoRoot, plan);

  for (const action of plan.actions) {
    // Whatever the kind, a write that cannot reach its path is a conflict with
    // the way out beside it, never an exception out of the middle of the loop.
    const writePathReason =
      action.target === undefined
        ? undefined
        : (blockedWritePaths.get(action.target) ?? unwritableTargets.get(action.target));
    if (writePathReason !== undefined) {
      conflicts.push({ ...action, reason: writePathReason });
      continue;
    }
    switch (action.kind) {
      case 'symlink': {
        const blockedReason = applySymlink(repoRoot, action);
        // A real file/dir blocks the link — left intact, with the way out.
        if (blockedReason === undefined) applied.push(action);
        else conflicts.push({ ...action, reason: blockedReason });
        break;
      }
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

  // Each sweep is tagged with its own cause as it runs, which is the only place
  // the cause is known: by the time the six lists are concatenated, a path is
  // just a path (see `sweep-reasons.ts`).
  const removals = opts?.sweepOrphans
    ? [
        ...explainSweep(sweepInstalledOrphans(repoRoot, plan), 'installed-skill'),
        ...explainSweep(sweepAuthoredOrphans(repoRoot, plan), 'authored-link'),
        ...explainSweep(sweepGeneratedOrphans(repoRoot, plan), 'generated-hooks'),
        ...explainSweep(sweepGeneratedCommandOrphans(repoRoot, plan), 'command-wrapper'),
        ...explainSweep(sweepOpencodeCommandOrphans(repoRoot, plan), 'command-wrapper'),
        ...explainSweep(sweepSettingsHooksOrphan(repoRoot, plan), 'settings-hooks'),
      ]
    : [];
  return { applied, conflicts, swept: removals.map(({ path }) => path), removals, leftAlone };
}

/** Whether a single action's on-disk target diverges from the plan. */
function isDrifted(repoRoot: string, action: ProjectionAction): boolean {
  switch (action.kind) {
    case 'symlink': {
      if (!action.source || !action.target) return true;
      const absTarget = join(repoRoot, action.target);
      // A real file or directory here is BLOCKED, not stale — `--fix` will refuse
      // it, so calling it drift would tell the person to run a command they then
      // watch decline. `checkPlan` reports it in `blocked` instead. Absent, and a
      // link of either kind pointing somewhere else, are the real drift.
      const kind = occupantKind(absTarget);
      if (kind === 'absent') return true;
      if (kind === 'file' || kind === 'directory') return false;
      const linkText = relativeLink(repoRoot, action.source, action.target);
      return !linkMatchesPlan(absTarget, join(repoRoot, action.source), linkText, LINK_CHECK);
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
 * Symlink targets a real file or directory occupies — what `--fix` will report as
 * a conflict, gathered without touching disk.
 *
 * The twin of {@link findBlockedGenerateTargets}, reading the same predicate
 * `applySymlink` reads, so `--check` and `--fix` say the same sentence about the
 * same path. The commonest instance by far is not anybody's mistake: a clone
 * whose `core.symlinks` is off has a plain file at EVERY authored link (J-10).
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (its symlink targets are checked).
 * @returns the blocked symlink actions, each carrying its reason.
 */
function findBlockedSymlinkTargets(repoRoot: string, plan: ProjectionPlan): ProjectionAction[] {
  const blocked: ProjectionAction[] = [];
  for (const action of plan.actions) {
    if (action.kind !== 'symlink' || !action.source || !action.target) continue;
    const reason = blockingSymlinkOccupant(
      join(repoRoot, action.target),
      relativeLink(repoRoot, action.source, action.target)
    );
    if (reason !== undefined) blocked.push({ ...action, reason });
  }
  return blocked;
}

/**
 * Everything a sweep of this plan would remove, without removing any of it.
 *
 * The union of all six finders, sorted and de-duplicated — the read-only twin of
 * the six sweeps {@link applyPlan} runs, and equal to the `swept` list the next
 * `applyPlan(..., { sweepOrphans: true })` returns. Equality, not containment:
 * "most of what will be deleted" is a warning with a hole in it, and the hole is
 * where the surprise lives (DOR-1889).
 *
 * The six are disjoint by construction — the installed sweep owns `__` links,
 * the authored one everything under `.claude/skills` without a `__`, each
 * command sweep its own directory, the generated one the per-harness hooks
 * paths, and the settings one a single file — so the de-duplication is a
 * guarantee about the ANSWER rather than a patch over overlapping predicates.
 * It is also what lets each path keep exactly one reason: a path two finders
 * both claimed would otherwise arrive with two.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns the repo-relative paths with their reasons, sorted by path and unique.
 */
function findOrphans(repoRoot: string, plan: ProjectionPlan): SweptPath[] {
  const found = [
    ...explainSweep(findInstalledOrphans(repoRoot, plan), 'installed-skill'),
    ...explainSweep(findOrphanedAuthoredLinks(repoRoot, plan), 'authored-link'),
    ...explainSweep(findGeneratedOrphans(repoRoot, plan), 'generated-hooks'),
    ...explainSweep(findGeneratedCommandOrphans(repoRoot, plan), 'command-wrapper'),
    ...explainSweep(findOpencodeCommandOrphans(repoRoot, plan), 'command-wrapper'),
    ...explainSweep(findSettingsHooksOrphan(repoRoot, plan), 'settings-hooks'),
  ];
  const byPath = new Map<string, SweptPath>();
  // First finder wins, which is what the `Set` this replaced did. The six are
  // disjoint, so this never actually decides anything — it is here so that a
  // seventh sweep overlapping an existing one is a duplicate dropped rather than
  // a reason quietly overwritten.
  for (const removal of found) if (!byPath.has(removal.path)) byPath.set(removal.path, removal);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Diff a projection plan against the current on-disk state without mutating it.
 *
 * Four answers, deliberately kept apart: what is stale and a re-run would fix
 * (`drifted`), what a re-run would report as a conflict because somebody's own
 * file occupies a target the plan writes or links (`blocked`), what a re-run
 * would sweep because whatever it came from is gone (`orphans`), and what the
 * engine simply stepped over (`leftAlone`). The first three make a tree unclean
 * — each is something a `--fix` would change on disk — and the last does not: a
 * person who keeps their own `.codex/hooks.json` in a repo DorkOS projects no
 * hooks to is not carrying a fault.
 *
 * It never throws for what it finds on disk. A dead link, a directory where a
 * file belongs, an unreadable `.claude/skills` — each is an answer (drift,
 * blocked, or nothing at all), never an exception: this is the command a person
 * runs to be TOLD what is wrong with their tree.
 *
 * **A plan narrowed to one harness reports no orphans**, whoever asks. Every
 * finder reads the plan as its keep-set, so a narrowed plan — which omits every
 * other harness's live projections — would call them orphans and hand back a
 * list a `--fix` refuses to act on: `projectWithConsent` will not sweep a
 * filtered plan at all. An empty list is the honest answer to a question this
 * plan cannot answer, and it lives here rather than in each caller so that every
 * reader of `DriftResult` gets it (DOR-1889).
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the projection plan to check.
 * @returns the drifted actions, the blocked ones, the orphans a sweep would
 *   take (bare and with the reason each one goes), the paths left alone, and
 *   whether the tree is clean.
 */
export function checkPlan(repoRoot: string, plan: ProjectionPlan): DriftResult {
  // The same pure pass `applyPlan` acts on, so `--check` names a hostile folder
  // BEFORE anyone runs the write that used to die on it (DOR-1882). It wins over
  // the target's own shape: `.claude/commands` being a file is why nothing is at
  // `.claude/commands/acme/hello.md`, and naming the consequence instead of the
  // cause would send a person to look at a path that is not the problem.
  const blockedWritePaths = findBlockedWritePaths(repoRoot, plan);
  const onBlockedPath = (action: ProjectionAction): boolean =>
    action.target !== undefined && blockedWritePaths.has(action.target);

  // Drift is asked once and used twice: it is the answer, and it is also what
  // scopes the permission probe — a projection already on disk is one nothing
  // writes to, so its folder's mode is nobody's business (`unwritableWritePath`).
  const wouldWrite = plan.actions.filter(
    (action) => !onBlockedPath(action) && isDrifted(repoRoot, action)
  );
  const unwritableTargets = findUnwritableTargets(repoRoot, wouldWrite);
  const drifted = wouldWrite.filter(
    (action) => !(action.target !== undefined && unwritableTargets.has(action.target))
  );
  const blocked = [
    ...plan.actions.flatMap((action) => {
      const reason =
        action.target === undefined
          ? undefined
          : (blockedWritePaths.get(action.target) ?? unwritableTargets.get(action.target));
      return reason === undefined ? [] : [{ ...action, reason }];
    }),
    ...findBlockedGenerateTargets(repoRoot, plan).filter((a) => !onBlockedPath(a)),
    ...findBlockedSymlinkTargets(repoRoot, plan).filter((a) => !onBlockedPath(a)),
  ];
  const removals = plan.narrowedTo === undefined ? findOrphans(repoRoot, plan) : [];
  return {
    drifted,
    blocked,
    orphans: removals.map(({ path }) => path),
    removals,
    leftAlone: findLeftAloneGeneratedHookFiles(repoRoot, plan),
    // A skill folder nobody could read is the fourth way this answer is not
    // "everything is as the plan says": the sweeps stood down over it, so the
    // tree may hold links a readable folder would have settled either way, and
    // saying `clean` over that is the same lie as saying it over nine files a
    // sync would delete (DOR-1882).
    clean:
      drifted.length === 0 &&
      blocked.length === 0 &&
      removals.length === 0 &&
      !skillSourcesUnreadable(plan),
  };
}
