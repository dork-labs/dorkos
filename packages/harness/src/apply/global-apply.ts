/**
 * Apply / check a global plan — the half that writes, and the predicate that
 * decides what it may remove.
 *
 * ## The clause the repository predicate does not have
 *
 * At project scope a candidate under `.agents/skills` or `.claude/skills` is
 * swept when its basename carries `__` and it is a real symlink — two clauses,
 * and sufficient in a repository, where every symlink in those directories was
 * put there by the engine.
 *
 * It is not sufficient in a home directory. People hand-build the exact
 * projection this feature automates: on the operator's own machine
 * `~/.claude/skills/composio-cli` and `~/.claude/skills/find-skills` are
 * relative symlinks into `~/.agents/skills/`, whose targets are directories a
 * person wrote. Under the two-clause predicate the only thing standing between
 * those links and a sweep is the absence of `__` in their names. So a global
 * sweep asks a third question — **is this link OURS?** — and answers it from the
 * link's own text.
 *
 * ## The predicate, all clauses required
 *
 * ```
 * A candidate directly inside a directory the global roots declare is swept when:
 *   1. `lstat` says it is a symlink; and
 *   2. its basename contains `__`; and
 *   3. the link's own text, resolved LEXICALLY against the directory the link
 *      sits in, is inside `<dorkHome>/plugins`; and
 *   4. EITHER the package directory that text points into is gone from disk,
 *      OR the plan enumerated that package and does not name this target.
 * Clauses 1-3 decide ownership. Clause 4 decides orphanhood.
 * ```
 *
 * **Clause 4 is not "the plan does not name it", and the difference is a
 * measured data-loss bug.** The plan is evidence only about packages the scan
 * could read: a package whose `.dork/manifest.json` a person broke half an hour
 * ago is skipped by the scan, so a keep-set of planned targets alone called all
 * of its links orphans and removed them — and the live reconciler then paused
 * every schedule that ran from one. A broken manifest costs a package its
 * projection; it must never cost it its links. So a package still ON DISK keeps
 * its links whatever its manifest says, and the plan gets the last word only
 * about the packages it actually enumerated — which is what still lets a skill
 * renamed inside a readable package have its stale link swept.
 *
 * Three details decide whether that is correct rather than merely careful:
 *
 * - **Clause 3 reads the link text, never `realpath`.** A global uninstall
 *   removes the package directory first, so the links it leaves behind are
 *   dangling and `realpath` throws on exactly the orphans the sweep exists to
 *   remove. Resolving `readlinkSync(p)` against `dirname(p)` normalises `..`
 *   without touching the filesystem, so a dead DorkOS link is still recognisably
 *   ours.
 * - **Containment is a path-segment test.** A bare `startsWith` matches
 *   `<dorkHome>/plugins-of-someone-else`.
 * - **The sweep never descends.** It reads one level of each target directory,
 *   so a person's own subdirectory tree is not walked and nothing inside it can
 *   be a candidate.
 *
 * ## What it may not do
 *
 * A target that is already occupied is a **conflict, never an overwrite** — P3
 * holds unchanged at global scope, through the same `blockingSymlinkOccupant`
 * predicate the project apply reads, so a person's hand-built version of this
 * projection is safe twice over: the sweep will not remove it and the apply will
 * not replace it.
 *
 * `roots` is passed to both functions rather than read off the plan, for the
 * same reason `applyPlan` takes `repoRoot`: an apply that trusts a path carried
 * inside the thing it is applying can be pointed anywhere by a malformed plan.
 * Passing the roots twice gives the containment check an independent second
 * opinion.
 *
 * @module apply/global-apply
 */
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  globalPluginsDir,
  globalSkillsDir,
  type GlobalPlanRoots,
  type GlobalProjectionPlan,
} from '../plan/global-projector.js';
import type { DriftResult, ProjectionAction, SweptPath } from '../plan/types.js';
import { INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';
import { listDir, occupantKind, pathExists } from './link-state.js';
import { directoryWriteBlock, writePathDirs, writePathReason } from './write-path-occupants.js';
import { SWEEP_REASONS } from './sweep-reasons.js';
import { blockingSymlinkOccupant, linkCheckFor, linkMatchesPlan } from './symlink-occupants.js';

/**
 * How this platform decides whether a link on disk is the link the plan wants.
 *
 * Resolved once at module scope, exactly as `apply.ts` does it: it is a property
 * of the running platform rather than of any one path, and `--check` and the
 * apply must ask the same question.
 */
const LINK_CHECK = linkCheckFor(process.platform);

/**
 * How many times {@link applyGlobalSymlink} looks again after another writer
 * beat it to the target. The same three the project apply allows, for the same
 * reason: the loop only repeats when the path CHANGED under it.
 */
const SYMLINK_ATTEMPTS = 3;

/**
 * The directories a global sweep reads, in the order they are scanned.
 *
 * Derived from the ROOTS and never from the plan's own actions, and that is the
 * whole of why an uninstall works: when the last global package is removed the
 * plan has no actions at all, so a sweep scoped to "directories this plan
 * targets" would scan nothing and strand every link the package left behind.
 * The roots are the standing answer to where DorkOS writes.
 *
 * **The converse is the dangerous half, and it is answered in the predicate
 * below rather than here.** Scanning a directory the plan knows nothing about
 * only works because the plan is NOT the keep-set: an empty plan means "nothing
 * is installed" exactly when the scan succeeded and found nothing, and means
 * nothing at all when it could not read the folder or could not parse a
 * package. Both of those are handled — `unreadableRoot` skips the sweep
 * outright, and clause 4 keeps the links of any package still on disk that this
 * plan did not enumerate.
 *
 * **The two user roots are here, and only the REACH widened** — the predicate
 * below is unchanged from the slice that wrote it for one directory. That is
 * what the third clause bought: a directory in somebody's home folder holds
 * their own files, their own hand-built symlinks and another installer's
 * directories, and the predicate already answers "is this ours" from the link's
 * own text rather than from where it sits.
 *
 * A root that was not passed is not scanned. That is one rule with three
 * callers: a boundary-confined deployment, an unanswered sharing question and a
 * machine with no enabled harness all pass the same absent root, and nothing
 * beneath it is read or removed.
 *
 * **A root IS scanned when the plan targets no links in it**, and that is the
 * difference `--disable` is built on rather than a bug: the sweep's job is to
 * remove what the current plan no longer names, so a directory whose last reader
 * was just turned off must still be read once to empty it.
 *
 * @param roots - the roots the plan was built from.
 * @returns the absolute directories to scan, one level each, without duplicates.
 */
function globalSweepDirs(roots: GlobalPlanRoots): string[] {
  // A `Set`, because nothing stops a caller pointing two roots at one directory
  // — `CLAUDE_CONFIG_DIR=~/.agents` is legal — and scanning it twice would offer
  // the same path for removal twice.
  return [
    ...new Set(
      [globalSkillsDir(roots.dorkHome), roots.agentsSkillsDir, roots.claudeSkillsDir].filter(
        (dir): dir is string => dir !== undefined
      )
    ),
  ];
}

/**
 * Whether `child` is `root` or sits inside it, judged one path segment at a
 * time.
 *
 * `startsWith` alone answers `true` for `<dorkHome>/plugins-of-someone-else`
 * against `<dorkHome>/plugins`, which is a neighbouring directory DorkOS has no
 * claim over whatever it is called.
 *
 * @param child - the resolved candidate path.
 * @param root - the resolved containing directory.
 * @returns `true` when `child` is inside `root`, or is `root` itself.
 */
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/**
 * The package a candidate link belongs to — clauses 1 to 3 of the predicate,
 * answered with the package's NAME rather than with a yes.
 *
 * Never follows the link and never resolves it against the filesystem: a
 * dangling link left by a package that has been uninstalled is exactly the case
 * this has to recognise, and `realpath` throws on it.
 *
 * A link pointing AT the plugins root itself passes clauses 1 to 3 and names no
 * package. It answers `undefined` — which the caller reads as "not ours to
 * remove", because a candidate DorkOS cannot attribute to a package is a
 * candidate it cannot say has been uninstalled.
 *
 * @param abs - the absolute candidate path, directly inside a swept directory.
 * @param pluginsRoot - the resolved `<dorkHome>/plugins`.
 * @returns the package directory name, or `undefined` when this is not one of
 *   ours or names no package.
 */
function globalLinkPackage(abs: string, pluginsRoot: string): string | undefined {
  if (!basename(abs).includes(INSTALLED_PROJECTION_MARKER)) return undefined;
  let stats;
  try {
    stats = lstatSync(abs);
  } catch {
    return undefined;
  }
  if (!stats.isSymbolicLink()) return undefined;
  let text: string;
  try {
    text = readlinkSync(abs);
  } catch {
    return undefined;
  }
  const resolved = resolve(dirname(abs), text);
  if (!isInside(resolved, pluginsRoot)) return undefined;
  const [first] = relative(pluginsRoot, resolved).split(sep);
  return first === undefined || first === '' || first === '..' ? undefined : first;
}

/** Every absolute `symlink` target the plan names. */
function plannedTargets(plan: GlobalProjectionPlan): Set<string> {
  return new Set(
    plan.actions
      .filter((a) => a.kind === 'symlink' && a.target !== undefined)
      .map((a) => resolve(a.target as string))
  );
}

/**
 * Everything a global sweep would remove, without removing any of it.
 *
 * The read-only twin of {@link sweepGlobalOrphans}, and equal to the `swept`
 * list the next `applyGlobalPlan(..., { sweepOrphans: true })` returns —
 * equality in both directions, joining the contract DOR-1889 set for the six
 * project sweeps rather than being retro-fitted to it later.
 *
 * Each path carries the one sentence saying why it goes, from the same
 * `sweep-reasons.ts` the six project sweeps read — and the global sweep has two
 * causes, not one: the package was uninstalled, or the package is still there
 * and no longer has a skill of that name. A person reading a list of deletions
 * is owed the difference.
 *
 * @param plan - the current global plan (its symlink targets are kept).
 * @param roots - the roots the plan was built from.
 * @returns the absolute paths a sweep would remove with their reasons, sorted by
 *   path and unique.
 */
export function findGlobalOrphans(plan: GlobalProjectionPlan, roots: GlobalPlanRoots): SweptPath[] {
  // A plan built from a folder nobody could read is evidence of nothing, and a
  // sweep run on it removes everything. Answered here rather than at each
  // caller so `--check`, the apply and every future reader get the rule.
  if (plan.unreadableRoot !== undefined) return [];

  const pluginsRoot = resolve(globalPluginsDir(roots.dorkHome));
  const planned = plannedTargets(plan);
  const enumerated = new Set(plan.enumeratedPackages);
  const orphans = new Map<string, string>();
  // Which directories the plan still writes into. A candidate in a directory the
  // plan names nothing in is a THIRD cause, and it needs its own sentence: the
  // package is installed, the skill exists, and what changed is that nobody
  // reads this folder for it any more. Told as "no longer has a skill of this
  // name", a `--disable` would say something false about the package to a person
  // watching two links go.
  const plannedDirs = new Set([...planned].map((target) => dirname(target)));
  for (const dir of globalSweepDirs(roots)) {
    // `listDir`, never `existsSync` + `readdirSync`: a skills path that is a
    // file or unreadable has nothing to sweep and must not abort the run, nor
    // throw out of the `--check` that reads the same scanner.
    for (const entry of listDir(dir)) {
      const abs = resolve(dir, entry);
      const pkg = globalLinkPackage(abs, pluginsRoot);
      if (pkg === undefined) continue; // not ours, or unattributable
      if (planned.has(abs)) continue; // still projected — keep
      // The package is gone from disk: this link came from an uninstall.
      if (!existsSync(join(pluginsRoot, pkg))) {
        orphans.set(abs, SWEEP_REASONS['global-package-gone']);
        continue;
      }
      // The package is still installed. The plan may only overrule that for a
      // package it actually read — otherwise a broken manifest would look
      // exactly like an uninstall.
      if (!enumerated.has(pkg)) continue;
      orphans.set(
        abs,
        plannedDirs.has(resolve(dir))
          ? SWEEP_REASONS['global-skill-gone']
          : SWEEP_REASONS['global-folder-unshared']
      );
    }
  }
  return [...orphans.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, reason]) => ({ path, reason }));
}

/**
 * Remove everything {@link findGlobalOrphans} names.
 *
 * Every path it hands back is a symlink, so the link goes and nothing at the
 * other end of it is ever touched.
 *
 * @param plan - the current global plan (its symlink targets are kept).
 * @param roots - the roots the plan was built from.
 * @returns the absolute paths removed with their reasons, sorted and unique.
 */
export function sweepGlobalOrphans(
  plan: GlobalProjectionPlan,
  roots: GlobalPlanRoots
): SweptPath[] {
  const orphans = findGlobalOrphans(plan, roots);
  for (const { path } of orphans) rmSync(path, { force: true });
  return orphans;
}

/**
 * The symlink type to request for an absolute source. Windows needs `'junction'`
 * for a directory target; POSIX ignores the argument. The stat FOLLOWS the
 * source deliberately — a source that is itself a link into a shared directory
 * is still a directory, and asking Windows for a file link to one is the exact
 * EPERM this avoids.
 */
function symlinkTypeFor(absSource: string): 'junction' | 'file' | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    return statSync(absSource).isDirectory() ? 'junction' : 'file';
  } catch {
    return undefined;
  }
}

/** The relative link text that points from an absolute target to an absolute source. */
function globalLinkText(action: ProjectionAction): string {
  return relative(dirname(action.target as string), action.source as string);
}

/**
 * What one global symlink action did.
 *
 * `'unchanged'` is the whole reason this is three values rather than the project
 * apply's two — see {@link applyGlobalPlan} for why a global run reports what it
 * CHANGED rather than what it realized.
 */
type SymlinkOutcome =
  { kind: 'written' } | { kind: 'unchanged' } | { kind: 'blocked'; reason: string };

/**
 * Whether this platform can be asked about write PERMISSION at all.
 *
 * Not Windows, for the reason `write-path-occupants.ts` states about its own
 * probe: `accessSync(dir, W_OK)` there reports the read-only ATTRIBUTE, which
 * directories do not meaningfully carry, and answers "writable" for a folder an
 * ACL denies. A probe that is wrong in both directions is worse than the write
 * reporting the failure itself.
 *
 * A FUNCTION rather than a module constant, and read at each call, so a test can
 * ask what a Windows run would answer. The distinction it draws is the one that
 * broke on Windows: the permission half is platform-bound and the SHAPE half is
 * not, and a single module-scope gate in front of both took the working half
 * down with the one that cannot work.
 *
 * @returns `true` where `accessSync` means what it says about a directory.
 */
function canAskAboutWriting(): boolean {
  return process.platform !== 'win32';
}

/**
 * Why a global link cannot be written, when the folder that would hold it says
 * no — asked BEFORE the write, so a person is told rather than shown a stack.
 *
 * The project engine answers this for every write path between the repository
 * root and the target (`unwritableWritePath`). A global plan needs one directory
 * probed and not a path: the roots are absolute and given, and everything under
 * them this engine makes itself. `chmod 000` on `~/.agents/skills` is the case
 * that made this necessary — the sweep already skips an unreadable directory
 * (`listDir` answers nothing and removes nothing), and the APPLY threw a raw
 * EACCES over it, so the run that removed nothing said so with a stack trace.
 *
 * A folder that is not there yet is not probed: the engine creates it, inside a
 * parent it will fail on visibly if it may not.
 *
 * @param target - the absolute link target.
 * @returns the sentence, or `undefined` when the write may go ahead.
 */
function unwritableGlobalDir(target: string, memo: WritePathMemo): string | undefined {
  // SHAPE, on every platform, over every ancestor, OUTERMOST first — the exact
  // walk `findBlockedWritePaths` does for a repository, through the exact
  // helpers, so the two cannot answer differently about the same shape. Naming
  // the outermost obstacle is what makes the answer actionable: a file at
  // `~/.agents` makes `~/.agents/skills` unreadable too, and naming the deeper
  // one sends somebody to look at a path that is only wrong because of the one
  // above it. `directoryWriteBlock` answers `undefined` for a level that is
  // simply absent, which is every level this engine is about to create.
  //
  // TWO bugs lived in the version this replaces, and Windows found both.
  //
  // It asked only about the target's immediate parent and answered `undefined`
  // for anything that was not a directory — "a shape question, answered
  // elsewhere" — and at global scope there IS no elsewhere: no global path ever
  // reaches `findBlockedWritePaths`. And it returned early on the whole probe
  // when the platform could not answer about PERMISSION, which took the shape
  // half down with it on Windows, where the shape half is the one that works.
  // A plain file at `~/.agents/skills` therefore sailed past on both counts and
  // raised EEXIST out of `mkdirSync`, after the config had recorded the answer.
  //
  // The platforms disagree about which error a bad ancestor produces — Windows
  // answers ENOENT for a stat under a file and EEXIST for the `mkdir`, POSIX
  // answers ENOTDIR for both — and that is exactly why this asks `statSync`
  // through DOR-1882's helper rather than reading an `errno` of its own.
  for (const dir of writePathDirs(target)) {
    const reason = memoisedShapeBlock(dir, memo);
    if (reason !== undefined) return reason;
  }

  // PERMISSION second, only where the platform can answer it, and only of the
  // one folder that will really take the new entry: the deepest ancestor that
  // already exists. Everything below it this engine creates itself, inside a
  // parent it has just proved it may write in.
  if (!canAskAboutWriting()) return undefined;
  const parent = deepestExistingDir(target);
  if (parent === undefined) return undefined;
  try {
    accessSync(parent, constants.W_OK | constants.X_OK);
    return undefined;
  } catch {
    return writePathReason(parent, 'read-only');
  }
}

/**
 * The deepest ancestor of `target` that already exists on disk.
 *
 * The one folder a write really touches: `mkdirSync(..., { recursive: true })`
 * creates every level below it, and the level it starts from is the one whose
 * mode decides whether it may.
 *
 * `pathExists` is lstat-based on purpose: a DANGLING symlink is an entry
 * `mkdirSync` refuses, and an `existsSync` here would step over it.
 *
 * @param target - the absolute link target.
 * @returns the deepest existing ancestor directory, or `undefined` when none of
 *   them exists.
 */
function deepestExistingDir(target: string): string | undefined {
  const dirs = writePathDirs(target);
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const dir = dirs[i];
    if (dir !== undefined && pathExists(dir)) return dir;
  }
  return undefined;
}

/**
 * Cached answers about the directories a run writes into.
 *
 * Every action in a global plan lands in one of at most three directories, so
 * the probe is asked once per directory rather than once per link. It reads a
 * directory to decide (`directoryWriteBlock` lists it), and a plan of forty
 * skills across two roots would otherwise do that eighty times.
 */
type WritePathMemo = Map<string, string | undefined>;

/**
 * Whether this directory's SHAPE stops a write through it, asked at most once
 * per run.
 *
 * Shape only. Permission is a different question with a different scope (one
 * folder, not every ancestor) and a different platform answer, and it is asked
 * separately in {@link unwritableGlobalDir}.
 *
 * @param dir - an absolute ancestor of the link target.
 * @param memo - the run's cache.
 * @returns the sentence, or `undefined` when a write may pass through here.
 */
function memoisedShapeBlock(dir: string, memo: WritePathMemo): string | undefined {
  const cached = memo.get(dir);
  if (cached !== undefined || memo.has(dir)) return cached;
  const cause = directoryWriteBlock(dir);
  const reason = cause === undefined ? undefined : writePathReason(dir, cause);
  memo.set(dir, reason);
  return reason;
}

/**
 * Create or repair one global symlink.
 *
 * The same shape as the project apply's: look, act, and look again when another
 * writer got there first (EEXIST). Relative link text, so a dork home that is
 * moved or lives under a symlinked parent keeps working — which is not exotic,
 * every macOS temp directory is one.
 *
 * @param action - the `symlink` action, with absolute `source` and `target`.
 * @param memo - the run's cache of per-directory write answers.
 * @returns what happened at the target: written, already right, or blocked by
 *   something real that is left exactly where it is.
 */
function applyGlobalSymlink(action: ProjectionAction, memo: WritePathMemo): SymlinkOutcome {
  if (!action.source || !action.target) {
    throw new Error(`global symlink action for "${action.name}" is missing source/target`);
  }
  const absTarget = action.target;
  const absSource = action.source;
  const linkText = globalLinkText(action);

  // Asked before the write, so a folder that says no is a reported conflict
  // rather than a stack trace. Only when something is really about to be
  // written: a link that is already right is left alone above, and calling its
  // folder blocked would turn a clean tree into a wall of faults.
  const unwritable = unwritableGlobalDir(absTarget, memo);
  if (unwritable !== undefined && !linkMatchesPlan(absTarget, absSource, linkText, LINK_CHECK)) {
    return { kind: 'blocked', reason: unwritable };
  }

  for (let attempt = 0; attempt < SYMLINK_ATTEMPTS; attempt++) {
    if (pathExists(absTarget)) {
      const blocked = blockingSymlinkOccupant(absTarget, linkText);
      if (blocked !== undefined) return { kind: 'blocked', reason: blocked };
      // Already ours and already right: left exactly as it is. Removing and
      // recreating it would be invisible in a tree diff and would still be a
      // window in which the scheduler enumerating this folder sees one skill
      // fewer, for no gain at all.
      if (linkMatchesPlan(absTarget, absSource, linkText, LINK_CHECK)) return { kind: 'unchanged' };
      rmSync(absTarget, { force: true }); // a stale link of ours — safe to replace
    }
    mkdirSync(dirname(absTarget), { recursive: true });
    try {
      symlinkSync(linkText, absTarget, symlinkTypeFor(absSource));
      return { kind: 'written' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  const reason = blockingSymlinkOccupant(absTarget, linkText);
  return reason === undefined ? { kind: 'unchanged' } : { kind: 'blocked', reason };
}

/**
 * Realize a global plan on disk.
 *
 * Symlinks only. A `generate`, `scaffold` or `merge` action reaching here is a
 * stage somebody added to `buildGlobalPlan` without reading why it has none, and
 * it throws rather than writing: the rule "never generate at user scope" has
 * P8c to catch it in the suite and this to catch it in production.
 *
 * `leftAlone` is always empty and the type keeps it: that list is about
 * generated files the engine stepped over, and a global plan generates nothing.
 *
 * **`applied` is what this run CHANGED, not what it realized, and that is a
 * deliberate difference from `applyPlan`.** A project sync reports every link it
 * left correct, which reads as a summary of the projection; a global run is a
 * receipt for what DorkOS did to somebody's home directory, printed beside the
 * list of what it removed from the same place. "Created 40 links" said on every
 * run of a command that created none would be the same kind of untruth the
 * removal preview exists to prevent, and it would make the bar this surface is
 * held to — run it twice, the second run does nothing — unmeasurable.
 *
 * @param plan - the global plan to apply.
 * @param roots - the same roots the plan was built from, passed again so the
 *   sweep's containment check has an independent second opinion.
 * A plan carrying {@link GlobalProjectionPlan.unreadableRoot} sweeps nothing
 * whatever `sweepOrphans` says — the rule lives in {@link findGlobalOrphans}, so
 * `--check` and the apply cannot disagree about it.
 *
 * @param opts - optional flags; `sweepOrphans` enables the orphan sweep.
 * @returns the actions this run wrote, the blocked ones left intact, the
 *   absolute paths swept, and (always empty) the paths stepped over.
 */
export function applyGlobalPlan(
  plan: GlobalProjectionPlan,
  roots: GlobalPlanRoots,
  opts?: { sweepOrphans?: boolean }
): {
  applied: ProjectionAction[];
  conflicts: ProjectionAction[];
  swept: string[];
  removals: SweptPath[];
  leftAlone: string[];
} {
  const applied: ProjectionAction[] = [];
  const conflicts: ProjectionAction[] = [];
  // One cache per run: every action lands in one of at most three directories.
  const writeMemo: WritePathMemo = new Map();

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'symlink': {
        const outcome = applyGlobalSymlink(action, writeMemo);
        if (outcome.kind === 'written') applied.push(action);
        else if (outcome.kind === 'blocked') conflicts.push({ ...action, reason: outcome.reason });
        break;
      }
      case 'native':
      case 'drop':
        break;
      case 'generate':
      case 'scaffold':
      case 'merge':
        throw new Error(
          `applyGlobalPlan: a global plan may not ${action.kind} — "${action.name}" would write ` +
            `${action.target ?? '(no target)'} at user scope, which this engine never does.`
        );
    }
  }

  // `swept` stays a bare path list for the callers that only ever wanted paths,
  // and `removals` is the same list with each path's reason beside it — the
  // shape `applyPlan` settled on in DOR-1906.
  const removals = opts?.sweepOrphans ? sweepGlobalOrphans(plan, roots) : [];
  return {
    applied,
    conflicts,
    swept: removals.map(({ path }) => path),
    removals,
    leftAlone: [],
  };
}

/** Whether one global action's on-disk target diverges from the plan. */
function isGlobalDrifted(action: ProjectionAction): boolean {
  if (action.kind !== 'symlink') return false;
  if (!action.source || !action.target) return true;
  // A real file or directory here is BLOCKED, not stale: an apply will refuse
  // it, so calling it drift would tell a person to run a command they then watch
  // decline. Absent, and a link of either kind pointing elsewhere, are the real
  // drift.
  const kind = occupantKind(action.target);
  if (kind === 'absent') return true;
  if (kind === 'file' || kind === 'directory') return false;
  return !linkMatchesPlan(action.target, action.source, globalLinkText(action), LINK_CHECK);
}

/**
 * What a global sync would change, without changing it.
 *
 * Four answers kept apart exactly as `checkPlan` keeps them: what is stale
 * (`drifted`), what somebody else's file occupies (`blocked`), what a sweep
 * would remove (`orphans`), and what the engine stepped over (`leftAlone`,
 * always empty here). It never throws for what it finds on disk.
 *
 * @param plan - the global plan to check.
 * @param roots - the same roots the plan was built from.
 * @returns the drift result, with absolute paths throughout.
 */
export function checkGlobalPlan(plan: GlobalProjectionPlan, roots: GlobalPlanRoots): DriftResult {
  const drifted = plan.actions.filter(isGlobalDrifted);
  const blocked: ProjectionAction[] = [];
  const writeMemo: WritePathMemo = new Map();
  for (const action of plan.actions) {
    if (action.kind !== 'symlink' || !action.source || !action.target) continue;
    // Both questions, in the order the apply asks them, so `--check` and `--fix`
    // name the same paths for the same reasons. The permission probe is scoped
    // to the DRIFTED actions for the same reason the apply scopes it: a link
    // already correct is one nothing is about to write.
    const reason =
      blockingSymlinkOccupant(action.target, globalLinkText(action)) ??
      (isGlobalDrifted(action) ? unwritableGlobalDir(action.target, writeMemo) : undefined);
    if (reason !== undefined) blocked.push({ ...action, reason });
  }
  const removals = findGlobalOrphans(plan, roots);
  return {
    drifted,
    blocked,
    orphans: removals.map(({ path }) => path),
    removals,
    leftAlone: [],
    clean: drifted.length === 0 && blocked.length === 0 && removals.length === 0,
  };
}
