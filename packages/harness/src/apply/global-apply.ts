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
 *   4. the current global plan does not name that target path.
 * Clauses 1-3 decide ownership. Clause 4 decides orphanhood.
 * ```
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
import { lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
  globalPluginsDir,
  globalSkillsDir,
  type GlobalPlanRoots,
} from '../plan/global-projector.js';
import type { DriftResult, ProjectionAction, ProjectionPlan } from '../plan/types.js';
import { INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';
import { listDir, occupantKind, pathExists } from './link-state.js';
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
 * The roots are the standing answer to where DorkOS writes; the plan is only the
 * keep-set.
 *
 * One directory today. Slice A3 adds `agentsSkillsDir` and `claudeSkillsDir`
 * here, which is the whole of what "widening the reach" means — the predicate
 * below does not change.
 *
 * @param roots - the roots the plan was built from.
 * @returns the absolute directories to scan, one level each.
 */
function globalSweepDirs(roots: GlobalPlanRoots): string[] {
  return [globalSkillsDir(roots.dorkHome)];
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
 * Whether a path is a link DorkOS put there — clauses 1 to 3 of the predicate.
 *
 * Never follows the link and never resolves it against the filesystem: a
 * dangling link left by a package that has been uninstalled is exactly the case
 * this has to recognise, and `realpath` throws on it.
 *
 * @param abs - the absolute candidate path, directly inside a swept directory.
 * @param pluginsRoot - the resolved `<dorkHome>/plugins`.
 * @returns `true` when all three ownership clauses hold.
 */
function isDorkosGlobalLink(abs: string, pluginsRoot: string): boolean {
  if (!basename(abs).includes(INSTALLED_PROJECTION_MARKER)) return false;
  let stats;
  try {
    stats = lstatSync(abs);
  } catch {
    return false;
  }
  if (!stats.isSymbolicLink()) return false;
  let text: string;
  try {
    text = readlinkSync(abs);
  } catch {
    return false;
  }
  return isInside(resolve(dirname(abs), text), pluginsRoot);
}

/** Every absolute `symlink` target the plan names — the sweep's keep-set. */
function plannedTargets(plan: ProjectionPlan): Set<string> {
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
 * @param plan - the current global plan (its symlink targets are kept).
 * @param roots - the roots the plan was built from.
 * @returns the absolute paths a sweep would remove, sorted and unique.
 */
export function findGlobalOrphans(plan: ProjectionPlan, roots: GlobalPlanRoots): string[] {
  const pluginsRoot = resolve(globalPluginsDir(roots.dorkHome));
  const kept = plannedTargets(plan);
  const orphans = new Set<string>();
  for (const dir of globalSweepDirs(roots)) {
    // `listDir`, never `existsSync` + `readdirSync`: a skills path that is a
    // file or unreadable has nothing to sweep and must not abort the run, nor
    // throw out of the `--check` that reads the same scanner.
    for (const entry of listDir(dir)) {
      const abs = resolve(dir, entry);
      if (!isDorkosGlobalLink(abs, pluginsRoot)) continue;
      if (kept.has(abs)) continue;
      orphans.add(abs);
    }
  }
  return [...orphans].sort();
}

/**
 * Remove everything {@link findGlobalOrphans} names.
 *
 * Every path it hands back is a symlink, so the link goes and nothing at the
 * other end of it is ever touched.
 *
 * @param plan - the current global plan (its symlink targets are kept).
 * @param roots - the roots the plan was built from.
 * @returns the absolute paths removed, sorted and unique.
 */
export function sweepGlobalOrphans(plan: ProjectionPlan, roots: GlobalPlanRoots): string[] {
  const orphans = findGlobalOrphans(plan, roots);
  for (const abs of orphans) rmSync(abs, { force: true });
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
 * Create or repair one global symlink.
 *
 * The same shape as the project apply's: look, act, and look again when another
 * writer got there first (EEXIST). Relative link text, so a dork home that is
 * moved or lives under a symlinked parent keeps working — which is not exotic,
 * every macOS temp directory is one.
 *
 * @param action - the `symlink` action, with absolute `source` and `target`.
 * @returns what happened at the target: written, already right, or blocked by
 *   something real that is left exactly where it is.
 */
function applyGlobalSymlink(action: ProjectionAction): SymlinkOutcome {
  if (!action.source || !action.target) {
    throw new Error(`global symlink action for "${action.name}" is missing source/target`);
  }
  const absTarget = action.target;
  const absSource = action.source;
  const linkText = globalLinkText(action);

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
 * @param opts - optional flags; `sweepOrphans` enables the orphan sweep.
 * @returns the actions this run wrote, the blocked ones left intact, the
 *   absolute paths swept, and (always empty) the paths stepped over.
 */
export function applyGlobalPlan(
  plan: ProjectionPlan,
  roots: GlobalPlanRoots,
  opts?: { sweepOrphans?: boolean }
): {
  applied: ProjectionAction[];
  conflicts: ProjectionAction[];
  swept: string[];
  leftAlone: string[];
} {
  const applied: ProjectionAction[] = [];
  const conflicts: ProjectionAction[] = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'symlink': {
        const outcome = applyGlobalSymlink(action);
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

  const swept = opts?.sweepOrphans ? sweepGlobalOrphans(plan, roots) : [];
  return { applied, conflicts, swept, leftAlone: [] };
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
export function checkGlobalPlan(plan: ProjectionPlan, roots: GlobalPlanRoots): DriftResult {
  const drifted = plan.actions.filter(isGlobalDrifted);
  const blocked: ProjectionAction[] = [];
  for (const action of plan.actions) {
    if (action.kind !== 'symlink' || !action.source || !action.target) continue;
    const reason = blockingSymlinkOccupant(action.target, globalLinkText(action));
    if (reason !== undefined) blocked.push({ ...action, reason });
  }
  const orphans = findGlobalOrphans(plan, roots);
  return {
    drifted,
    blocked,
    orphans,
    leftAlone: [],
    clean: drifted.length === 0 && blocked.length === 0 && orphans.length === 0,
  };
}
