/**
 * The trigger that makes a skill an agent writes reach Claude Code within
 * seconds (contract SRC-06, TR-06, TR-07, SK-11; journey J-05).
 *
 * ## What was wrong
 *
 * Five of the six harnesses read `.agents/skills/` natively, so a skill Codex,
 * OpenCode or a DorkOS agent writes there is theirs immediately. Claude Code —
 * the default runtime — reads only `.claude/skills/`, and nothing was projecting
 * the link. So the skill an agent just wrote was invisible to the agent most
 * likely to be running, until a person ran `dorkos harness sync --fix`, or the
 * server restarted (and then only for agent workspaces DorkOS owns), or a
 * marketplace install happened to project the same repo.
 *
 * Three things close that, and they are deliberately different shapes:
 *
 * 1. **A watcher** on `<root>/.agents/skills` for every root the caller names —
 *    registered agent workspaces and the default project. This is the fast path:
 *    the file lands, and the link follows a fraction of a second later.
 * 2. **A sweep** over the same roots every {@link SKILLS_SWEEP_MS}, plus a
 *    re-arm every {@link SKILLS_REARM_MS}, because the fast path has two holes
 *    and neither is a small steady-state loss rate. chokidar cannot watch a
 *    directory that does not exist, so a project whose `.agents/skills` has not
 *    been created yet is **completely deaf** until the re-arm opens a watch on
 *    it; and a file written in the moments after a watch opens is dropped 13-40%
 *    of the time. A long-lived watcher over an existing directory misses
 *    nothing (0 of 40, measured). {@link SKILLS_SWEEP_MS} carries both
 *    measurements.
 * 3. **A turn-end re-projection** for the project a DorkOS-managed session ran
 *    in, which is how a repo NOBODY is watching still gets synced — a person's
 *    own checkout, a room worktree, any directory a session was pointed at.
 *
 * The last two share one record of what each project's skills last looked like
 * ({@link SkillsWatcherHandle.projectIfSkillsChanged}), so neither re-projects
 * what the other has already dealt with.
 *
 * ## Nothing here writes outside the boundary
 *
 * A projection writes real files, and the directories this module is handed are
 * not pre-checked: `DEFAULT_CWD` is an environment variable, and a session's
 * working directory comes from a runtime binding that a scheduled task can set
 * without any boundary call. So every root is judged twice — once before it is
 * watched at all, and once in {@link projectRoot}, which is the single point
 * every trigger's write passes through.
 *
 * ## The four hazards, and what this module does about each
 *
 * **1. Firing before the skill exists (TR-06).** A skill directory is created
 * first and its `SKILL.md` written a moment later. The scanner skips a directory
 * with no `SKILL.md`, so a projection between the two does nothing — and if that
 * were the only firing, the skill would never be projected at all. So a
 * directory is never a trigger here: `addDir` is not wired up, and what fires is
 * a `SKILL.md` arriving, changing or going away, or a skill directory being
 * removed. The projection that matters is the one the FILE causes, and it always
 * still comes. (A projection may happen at `mkdir` time anyway, from the
 * spurious `change` chokidar sometimes emits for a sibling — see the note at the
 * end. That is harmless precisely because it does not consume the trigger.)
 *
 * **2. Installing hooks nobody allowed.** A package's hooks are shell commands a
 * harness runs unattended. `project()` from `@dorkos/harness` installs every one
 * of them by contract, so this module never holds it: every firing goes through
 * {@link projectWithConsent}, the one seam that applies a person's stored
 * decisions and reports what it withheld (`__tests__/project-seam-guard.test.ts`
 * holds that line). And unlike the install trigger, **this one never asks**.
 * There is nobody at a file-change event, and an approval card raised at watcher
 * frequency is a card people learn to dismiss. Withheld hooks stay withheld and
 * are reported by the boot summary and by `dorkos harness sync --check`.
 *
 * **3. Sweeping at watcher frequency.** `sweepOrphans` deletes whatever the
 * current plan does not name — five sweeps, on a tree that may be mid-edit. That
 * is HK-11's blast radius, and running it every time a file changes is how a
 * half-written tree loses files a person still wants. So `sweepOrphans: false`
 * is passed on every firing, and it is not a default anybody can drift: the seam
 * requires the field. The visible cost is that deleting a skill leaves its
 * `.claude/skills/` link behind as a dead one. That is reported as an orphan by
 * `dorkos harness sync --check` and pruned by the next `--fix`; it is not this
 * trigger's to remove.
 *
 * **4. Projecting our own output.** The engine writes an installed package's
 * skills into `.agents/skills/<pkg>__<name>` — inside the very directory being
 * watched. Left alone, the first projection would fire the watcher, which would
 * project again. The exclusion is the engine's OWN predicate for a managed
 * projection (`scan/scanner.ts`): the `__` marker **and** a symlink on disk.
 * A real directory somebody named `my__helper` is authored content and still
 * triggers (DOR-1844), which is why the name alone is not the test.
 *
 * ## Why it can only touch a repo that already syncs
 *
 * `project()` reads `.agents/harness.manifest.json` with a bare `readFileSync`,
 * and this module does NOT scaffold one — unlike the install trigger, where a
 * person just asked for something. A root with no manifest is skipped with a
 * debug line. That is the safety property worth stating out loud: an unattended
 * trigger only ever writes into a project that is already set up for Harness
 * Sync, never into a repository that has not opted in.
 *
 * ## Serialization, and the queue bound
 *
 * Every firing runs under {@link withProjectLock}, so it takes its turn with the
 * marketplace install path instead of projecting into a tree that path has half
 * written. A lock turn can be LONG — `runAutoProjection` holds one across an
 * approval card, which a person has up to two hours to answer — so the watcher
 * must never queue one turn per file event behind it. It does not: at most ONE
 * firing per root is ever queued or running, and events arriving while it waits
 * set a flag that runs it exactly once more afterwards. Coalescing happens
 * twice, in fact — a burst inside {@link SKILLS_COALESCE_MS} becomes one
 * projection, and everything during a held lock becomes one more.
 *
 * ## Three deliberate differences from the scheduler's watcher
 *
 * `services/tasks/task-file-watcher.ts` watches the same directory for a
 * different reason, and this module copies its chokidar shape — `depth: 1`, and
 * `awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 }`, so a file
 * still being written is not read half-formed. Three things differ:
 *
 * - **A watch is only opened when there is something to watch.** The scheduler
 *   points chokidar at the path whether or not it exists, which for an absent
 *   `.agents/skills` means no watch at all and no way to notice (see
 *   {@link armWatch}). {@link rearm} is what comes back for it.
 * - **`ignoreInitial: true`.** The scheduler has to build its whole row set from
 *   what is already on disk, so it cannot ignore the initial scan. A projection
 *   of what is already there is `backfillAgentWorkspaceSkills`'s job at boot;
 *   this trigger is about what appears WHILE DorkOS is running, and firing one
 *   projection per watched root at startup would only duplicate that pass.
 * - **Directories, never files.** Every file the engine writes lands by
 *   temp-file-plus-rename, which swaps the directory entry — measured on macOS,
 *   a path-watcher on such a file sees nothing at all across three replaces
 *   (`packages/harness/src/apply/atomic-write.ts`). Watching the directory is
 *   the only shape that survives that, and chokidar's directory watch is what
 *   this uses.
 *
 * One more thing measured rather than assumed: chokidar occasionally reports a
 * `change` for a `SKILL.md` nobody touched, when a sibling directory appears
 * beside it. That costs one extra projection, which is idempotent and logged at
 * debug level, so it is left alone rather than filtered — and it is the reason
 * no test here asserts "exactly zero projections happened" off a filesystem
 * event. It cannot become a cycle: in a steady state a projection writes nothing
 * inside `.agents/skills`, so there is nothing for a spurious event to be about.
 *
 * @module services/harness/skills-watcher
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  AGENTS_SKILLS_DIR,
  CLAUDE_SKILLS_DIR,
  HARNESS_MANIFEST_PATH,
  INSTALLED_PROJECTION_MARKER,
  skillsFactsFor,
} from '@dorkos/harness';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { validateBoundaryOrDorkHome } from '../../lib/boundary.js';
import type { TurnBoundaryKind } from '../session/session-state-projector.js';
import { configManager } from '../core/config-manager.js';
import { logger } from '../../lib/logger.js';
import {
  projectWithConsent as defaultProjectWithConsent,
  withProjectLock,
} from './project-with-consent.js';

/**
 * How long a file must stop changing before chokidar reports it, and how often
 * that is checked.
 *
 * Both numbers are `services/tasks/task-file-watcher.ts`'s, copied rather than
 * re-chosen: the two watchers read the same directory, and a skill file that is
 * "finished" for one and not the other would be a difference nobody could
 * explain.
 */
const SKILL_WRITE_STABILITY_MS = 50;

/** @see {@link SKILL_WRITE_STABILITY_MS} */
const SKILL_WRITE_POLL_MS = 25;

/**
 * How long a burst of events for one root is collected before it becomes one
 * projection.
 *
 * A rename is an unlink plus an add; an editor's save is several events; a
 * package install writes a directory's worth of skills. Each of those is one
 * change to a person, and a projection per event would be a plan and an apply
 * per event. The window sits above {@link SKILL_WRITE_STABILITY_MS} so a single
 * file's own settling never spans two windows.
 */
export const SKILLS_COALESCE_MS = 250;

/**
 * How often the watched root set is rebuilt from the caller's list.
 *
 * The scheduler's own reconciliation runs on this cadence
 * (`meshCore.startPeriodicReconciliation(300_000)`), and a root arriving up to
 * five minutes late costs nothing but a delayed link. A caller that knows sooner
 * — an agent registering — calls {@link SkillsWatcherHandle.refreshRoots}
 * instead of waiting.
 */
export const SKILLS_ROOT_RESCAN_MS = 300_000;

/**
 * How often each root's skills are compared against what DorkOS last projected,
 * whatever the watcher did or did not report.
 *
 * **This is not belt and braces — there are two ways a real event never
 * arrives**, and neither is a steady-state loss rate:
 *
 * 1. **A deaf root.** chokidar cannot watch a path that does not exist; pointed
 *    at an absent `.agents/skills` it silently watches an ancestor instead and
 *    never picks the directory up ({@link armWatch} has the measurement). That
 *    is a 100% loss for that root until {@link SKILLS_REARM_MS} opens the real
 *    watch — and if the re-arm did not exist, for the life of the process.
 * 2. **The moments after a watch opens.** Measured against chokidar 5 on macOS,
 *    a skill written immediately after `ready` is dropped 13-40% of the time;
 *    the same watcher, left to settle first, missed 0 of 40, and a long-lived
 *    one missed 0 of 40 over the same writes. So this is a STARTUP artefact,
 *    not the ~22% steady-state loss an earlier version of this file claimed —
 *    {@link SKILLS_SETTLE_MS} is what actually addresses it.
 * 3. **A watch that has died.** The kernel's watch descriptors are a shared,
 *    finite resource, and this repo is routinely several agents plus the
 *    operator's own two servers on one machine. Measured here: a twenty-run test
 *    loop exhausted them outright and `fs.watch` began throwing `EMFILE` — at
 *    which point the watch reports nothing, for ever, and says so exactly once
 *    (the error handler in {@link armWatch}). Nothing in this module can prevent
 *    that; the comparison is what makes it cost seconds instead of the skill.
 *
 * What the comparison then buys is that neither of those can cost a skill: it
 * `readdir`s one directory per root and compares its entries' modification times
 * against the shape the last projection planned from. Its cost is one `readdir`
 * plus one `lstat` per skill per root per tick — measured at **201 syscalls and
 * 0.49 ms** for a root holding 200 skills, which at this interval is about
 * 0.005% of one core per root. `usePolling` would also cover both cases (0/20
 * missed, measured) and was refused because it pays a comparable cost against
 * every watched FILE on a much shorter timer, for ever, on a laptop already
 * running several agents.
 *
 * The same two exposures sit under the scheduler's watcher, where the
 * five-minute reconciler is what covers them.
 */
export const SKILLS_SWEEP_MS = 10_000;

/**
 * How often a root whose `.agents/skills` did not exist is checked to see
 * whether it does now.
 *
 * One `existsSync` per such root per tick, and only for roots that have no watch
 * — a project that already has skills never reaches it. Short, because this is
 * the whole latency of the FIRST skill in a project. Measured end to end against
 * the built CLI, on a project whose `.agents/skills` did not exist at boot: 432
 * ms from the file landing to the link existing, against the ~9.8s
 * {@link SKILLS_SWEEP_MS} alone would have cost.
 */
export const SKILLS_REARM_MS = 1_000;

/**
 * How long after chokidar reports `ready` a watch is treated as live.
 *
 * Measured against chokidar 5 on macOS: a file written in the instant after
 * `ready` is never reported 13-40% of the time, while the same watcher given
 * this long to settle first missed 0 of 40. A server's watchers live for hours
 * and are past this window before anything happens, so the cost is a tenth of a
 * second at boot; what it buys is that `ready()` is an honest barrier rather
 * than an optimistic one.
 */
export const SKILLS_SETTLE_MS = 100;

/** What caused a projection to be scheduled, for the log line. */
export type ProjectionTrigger =
  /** A `SKILL.md` was created, changed or removed under a watched root. */
  | 'skill-file'
  /** A whole skill directory went away under a watched root. */
  | 'skill-dir'
  /** A turn ended in a session whose project's skills had changed. */
  | 'turn-end'
  /** The periodic comparison caught a change the watcher never reported. */
  | 'sweep'
  /** `.agents/skills` appeared and a watch was opened on it for the first time. */
  | 'watch-armed';

/**
 * Seam for the one engine call this trigger makes, injectable so a test can
 * count firings without giving up the real engine.
 *
 * Exactly one entry, and it is the consent seam rather than `project()` — see
 * hazard 2 in the module docs.
 *
 * @internal Exported for testing only.
 */
export const _internal = {
  projectWithConsent: defaultProjectWithConsent,
};

/** What a caller gets back from {@link startSkillsWatcher}. */
export interface SkillsWatcherHandle {
  /**
   * Ask for one projection of `root`, coalesced with anything already pending
   * for it.
   *
   * The turn-end half comes through here too, which is what keeps "at most one
   * queued firing per root" true across both triggers rather than per trigger.
   *
   * @param root - The project root to project.
   * @param trigger - What asked for it, for the log line.
   */
  scheduleProjection(root: string, trigger: ProjectionTrigger): void;
  /**
   * Project `root` only if its skills look different from the shape DorkOS
   * recorded last, and record the shape either way.
   *
   * A root nothing has ever recorded projects: DorkOS has no picture of it to
   * compare against, and treating "no record" as "no change" is how the first
   * skill of every session would be the one that never arrived. The watcher
   * records the shape of every root it opens a watch on, so this only ever
   * reaches the no-record branch for a project nobody is watching — which is
   * exactly the turn-end trigger's case.
   *
   * @param root - The project root to consider.
   * @param trigger - What asked, for the log line.
   */
  projectIfSkillsChanged(root: string, trigger: ProjectionTrigger): void;
  /**
   * Rebuild the watched set from the caller's root list, now.
   *
   * Asynchronous because deciding whether a root may be watched at all means
   * asking the boundary, which resolves the path on disk.
   */
  refreshRoots(): Promise<void>;
  /** The roots currently being watched, resolved through symlinks. */
  watchedRoots(): string[];
  /**
   * Resolve once every open watcher has finished its first scan.
   *
   * Until then chokidar treats what it finds as ALREADY THERE, and
   * `ignoreInitial` drops it — so a file written in the moments between
   * {@link startSkillsWatcher} returning and the scan completing is silently not
   * an event. In a server that runs for hours that window is invisible and boot
   * projection covers it anyway; for anything that writes a skill immediately
   * after starting a watch, this is the barrier to wait on.
   */
  ready(): Promise<void>;
  /**
   * Run everything pending and wait for it to finish.
   *
   * @internal Exported for testing only — it collapses the coalescing window,
   *   which is the one thing a caller in production must not do.
   */
  flush(): Promise<void>;
  /** Close every watcher and drop every pending firing. */
  stop(): Promise<void>;
}

/** What {@link startSkillsWatcher} needs to know. */
export interface SkillsWatcherOptions {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /**
   * The roots to watch, re-read on every rescan.
   *
   * A function rather than an array because the set changes while the server
   * runs: an agent registers, another is unregistered, and the watcher has to
   * follow without the caller holding a subscription of its own.
   */
  roots: () => readonly string[];
  /** Override {@link SKILLS_COALESCE_MS}. @internal For tests. */
  coalesceMs?: number;
  /**
   * Whether DorkOS may write into a directory at all.
   *
   * Defaults to the server's own boundary
   * (`validateBoundaryOrDorkHome` — agent homes under `<dorkHome>/agents/*` are
   * inside it by that helper's own rule). Injectable because a test needs to
   * decide the answer without booting a server, and because the default reads
   * module state (`initBoundary`) this module does not own.
   */
  withinBoundary?: (path: string) => Promise<boolean>;
  /** Override {@link SKILLS_ROOT_RESCAN_MS}. @internal For tests. */
  rootRescanMs?: number;
  /** Override {@link SKILLS_SWEEP_MS}; `0` switches the sweep off. @internal For tests. */
  sweepMs?: number;
  /** Override {@link SKILLS_REARM_MS}; `0` switches re-arming off. @internal For tests. */
  rearmMs?: number;
  /** Override {@link SKILLS_SETTLE_MS}. @internal For tests. */
  settleMs?: number;
}

/** One root's pending work. */
interface RootState {
  /** The root, resolved through symlinks — also its key. */
  absRoot: string;
  /** The open coalescing window, if a burst is still being collected. */
  timer?: NodeJS.Timeout;
  /** The firing that is queued on the lock or running right now. */
  inFlight?: Promise<void>;
  /** Events arrived while {@link inFlight} was set; run once more afterwards. */
  again: boolean;
  /** What asked for the pending firing. */
  trigger: ProjectionTrigger;
}

/**
 * Resolve a path through symlinks when it exists, else normalize it lexically.
 *
 * The same rule {@link withProjectLock} keys on, for the same reason: a worktree
 * reached through a symlinked parent (every macOS temp directory is one) would
 * otherwise be two different roots to two different callers, and the lock would
 * serialize nothing.
 */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Whether a skill directory is one the engine wrote — the `__` marker AND a
 * symlink.
 *
 * Both halves, because they mean different things: `scan/scanner.ts` states that
 * a REAL directory named `my__helper` is somebody's own skill and is projected
 * like any other (DOR-1844), while the `<pkg>__<name>` symlink is the engine's
 * own output and must never trigger a projection of itself. A path that cannot
 * be inspected — the ordinary case when the event is a deletion — answers
 * `false`, so a package being uninstalled still gets a projection rather than
 * being silently ignored.
 *
 * @param skillDir - Absolute path to the skill directory the event was under.
 * @returns True when the engine wrote this entry.
 */
function isManagedProjection(skillDir: string): boolean {
  if (!basename(skillDir).includes(INSTALLED_PROJECTION_MARKER)) return false;
  try {
    return lstatSync(skillDir).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether a `SKILL.md` event under `skillsDir` should trigger a projection.
 *
 * Exported for the test that pins the four hazard cases in one place rather than
 * through the filesystem.
 *
 * @param filePath - The path chokidar reported.
 * @param skillsDir - The watched `<root>/.agents/skills` directory.
 * @returns True when this is an authored skill's `SKILL.md`, one level down.
 */
export function isAuthoredSkillFile(filePath: string, skillsDir: string): boolean {
  if (basename(filePath) !== SKILL_FILENAME) return false;
  const skillDir = dirname(filePath);
  if (dirname(skillDir) !== skillsDir) return false;
  if (basename(skillDir).startsWith('.')) return false;
  return !isManagedProjection(skillDir);
}

/**
 * What a root's canonical skills look like right now — one string that changes
 * whenever the SET of skills does.
 *
 * Every immediate entry of `.agents/skills` with its own modification time, and
 * nothing deeper. That is exactly the granularity a projection cares about: a
 * skill appearing, going away, or being replaced moves it, while an edit to a
 * `SKILL.md` that is already linked does not — and an edit needs no new
 * projection, because the link already points at the file.
 *
 * The directory's OWN mtime is not enough on its own, and that gap is the whole
 * reason this reads entries: a `SKILL.md` written into a directory that already
 * existed leaves the parent untouched, which is precisely the create-then-write
 * sequence whose event the watcher most often loses.
 *
 * The engine's own `<pkg>__<name>` links are left OUT, by the same predicate the
 * event filter uses. They are this module's output, not its input: counting them
 * would make the shape recorded before a projection differ from the tree after
 * it, and the next comparison would project again over nothing, for ever.
 *
 * @param absRoot - The project root, resolved.
 * @returns A comparable shape, or `-` when the directory cannot be read.
 */
function skillsShape(absRoot: string): string {
  const dir = join(absRoot, AGENTS_SKILLS_DIR);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return '-';
  }
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (isManagedProjection(join(dir, entry.name))) continue;
    try {
      parts.push(`${entry.name}:${lstatSync(join(dir, entry.name)).mtimeMs}`);
    } catch {
      // Gone between the listing and the stat: a rename mid-sweep. The next
      // sweep settles it, and guessing either way here would be worse.
      parts.push(`${entry.name}:?`);
    }
  }
  return parts.sort().join('|');
}

/**
 * Whether DorkOS may write into a directory, by the server's own boundary rule.
 *
 * `validateBoundaryOrDorkHome` rather than `validateBoundary`: the agent
 * workspaces DorkOS creates live under `<dorkHome>/agents/*` by design, and a
 * `DORKOS_BOUNDARY`-scoped deployment would otherwise refuse the very homes this
 * trigger exists to keep current. That helper narrows to the `agents` subtree
 * and nothing else in dork home, so the credential store stays out of reach.
 *
 * Any throw is a refusal, including the one an uninitialized boundary raises. A
 * projection writes files; the safe reading of "I could not tell" is no.
 *
 * @param path - The project root to judge.
 * @returns True when a projection may write there.
 */
async function defaultWithinBoundary(path: string): Promise<boolean> {
  try {
    await validateBoundaryOrDorkHome(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The sentence DorkOS is allowed to say about Claude Code picking a skill up
 * without a restart, and where it was read from.
 *
 * Read out of the vendor-facts table rather than written here, on the same rule
 * `dorkos harness sync --fix` follows for the Codex trust gate: a claim about
 * another company's software carries the page it came from and the day it was
 * read, or it is not made.
 *
 * @param createdTheDirectory - Whether this projection had to create
 *   `.claude/skills/` — the case where a restart is certain rather than likely.
 * @returns The hint and its citation, for the log line's structured fields.
 */
function claudeCodeRestartNote(createdTheDirectory: boolean): {
  hint: string;
  source: string;
} {
  const facts = skillsFactsFor('claude-code');
  const hint = createdTheDirectory
    ? 'DorkOS had to create .claude/skills/ for this project. Claude Code only watches that folder if it was already there when the session started, so restart any Claude Code session you have open before looking for the new skill.'
    : 'Claude Code picks up a new skill in .claude/skills/ without a restart, as long as that folder was already there when the session started. If it was not, restart the session.';
  return { hint, source: `${facts.source.url}, read ${facts.source.fetchedAt}` };
}

/**
 * Start watching every root's `.agents/skills` and projecting what appears
 * there.
 *
 * No-op when `harness.autoSync` is off: the answer is `undefined`, no watcher is
 * opened, and the caller has nothing to hand the turn-end half either. That is
 * the same switch the install trigger honours, and a person who turned
 * projection off should not have it resume because a file changed.
 *
 * @param opts - Dork home, the root list, and the two timing overrides.
 * @returns The handle, or `undefined` when `harness.autoSync` is off.
 */
export function startSkillsWatcher(opts: SkillsWatcherOptions): SkillsWatcherHandle | undefined {
  if (!configManager.get('harness').autoSync) {
    logger.debug('[HarnessSync] Skills watcher not started (harness.autoSync=false)');
    return undefined;
  }

  const coalesceMs = opts.coalesceMs ?? SKILLS_COALESCE_MS;
  const withinBoundary = opts.withinBoundary ?? defaultWithinBoundary;
  const settleMs = opts.settleMs ?? SKILLS_SETTLE_MS;
  /**
   * Every root this watcher is responsible for, in-bounds and canonical.
   *
   * Kept apart from {@link watchers} because the two genuinely differ: a root
   * whose `.agents/skills` does not exist yet has no watcher at all (chokidar
   * cannot watch a path that is not there — see {@link armWatch}) and is still
   * fully our responsibility.
   */
  const roots = new Set<string>();
  /** Only the roots whose `.agents/skills` exists and is being watched. */
  const watchers = new Map<string, { watcher: FSWatcher; ready: Promise<void> }>();
  const states = new Map<string, RootState>();
  /** Roots the restart caveat has already been said for, once each. */
  const restartNoteSaid = new Set<string>();
  /** Roots refused by the boundary, so the refusal is said once rather than per tick. */
  const refusedRoots = new Set<string>();
  /** What each root's skills looked like when DorkOS last projected it. */
  const shapes = new Map<string, string>();
  /** The root-set passes, chained so two can never interleave. */
  let syncing: Promise<void> = Promise.resolve();
  let stopped = false;

  /**
   * Project one root, once, under the lock — the whole of what a firing does,
   * and the ONE place a write is gated.
   *
   * Every path into this module ends here, so the boundary check, the
   * `harness.autoSync` check and the manifest check live here rather than at
   * each caller. Nothing throws out of it: a firing runs from a filesystem
   * event or a timer, where a rejection has nowhere to go but the process-wide
   * unhandled-rejection path — and a throw that escaped would leave the root
   * wedged, because the caller clears its in-flight marker in the same chain.
   */
  async function projectRoot(absRoot: string, trigger: ProjectionTrigger): Promise<void> {
    try {
      if (stopped) return;

      // THE WRITE GATE. A projection writes symlinks, `.claude/CLAUDE.md` and a
      // managed block in `.claude/settings.local.json`, so the directory it
      // writes into has to be one DorkOS is allowed to write into. The roots
      // this module is handed are NOT pre-checked: `DEFAULT_CWD` is an env var,
      // and a session's working directory comes from a runtime binding that
      // `routes/tasks.ts` can set with no boundary call at all — the read
      // resolvers say so in as many words ("the caller must still judge the
      // directory they get back", `resolve-read-cwd.ts`). So it is judged here,
      // at the one point every trigger passes through.
      //
      // `validateBoundaryOrDorkHome` rather than `validateBoundary`, because the
      // agent workspaces DorkOS creates live under `<dorkHome>/agents/*` by
      // design and a boundary-scoped deployment would otherwise refuse the very
      // homes this trigger exists to keep current.
      if (!(await withinBoundary(absRoot))) {
        if (!refusedRoots.has(absRoot)) {
          refusedRoots.add(absRoot);
          logger.debug('[HarnessSync] Refusing to project outside the directory boundary', {
            root: absRoot,
            trigger,
          });
        }
        return;
      }

      // Re-read rather than trusting the value at startup: a person who turns
      // projection off mid-session has turned it off for this too.
      if (!configManager.get('harness').autoSync) {
        logger.debug('[HarnessSync] Skipping watched projection (harness.autoSync=false)', {
          root: absRoot,
          trigger,
        });
        return;
      }
      // No manifest, no projection, and nothing scaffolded — see the module docs.
      if (!existsSync(join(absRoot, HARNESS_MANIFEST_PATH))) {
        logger.debug('[HarnessSync] Skipping watched projection — the project has no manifest', {
          root: absRoot,
          trigger,
        });
        return;
      }

      const claudeSkillsExisted = existsSync(join(absRoot, CLAUDE_SKILLS_DIR));
      // The shape the projection is ABOUT, read before the plan is built, and
      // committed as the record only once the projection has succeeded. Both
      // halves of that are load-bearing. Recorded at detection instead, a
      // projection that throws is never retried — the change has already been
      // written down as dealt with. Recorded AFTER instead, a skill an agent
      // writes DURING the projection is captured by the post-snapshot and is
      // never planned by anything: the plan that ran never saw it, and the next
      // comparison thinks it did.
      const planned = skillsShape(absRoot);
      const result = await withProjectLock(absRoot, () =>
        // `sweepOrphans: false` is the third hazard, and the seam has no default
        // for it precisely so this line has to be written on purpose.
        _internal.projectWithConsent(absRoot, { dorkHome: opts.dorkHome, sweepOrphans: false })
      );
      shapes.set(absRoot, planned);
      const { applied, conflicts, withheld, leftAlone } = result;

      if (applied.length === 0 && conflicts.length === 0) {
        logger.debug('[HarnessSync] Watched projection had nothing to do', {
          root: absRoot,
          trigger,
        });
        return;
      }

      logger.info('[HarnessSync] Projected a skill written into .agents/skills', {
        root: absRoot,
        trigger,
        applied: applied.length,
        conflicts: conflicts.length,
        // Never asked about here, only counted: see hazard 2 in the module docs.
        hooksWithheld: withheld.length,
        leftAlone: leftAlone.length,
      });

      // Said only when something actually landed where Claude Code reads, and
      // then at most once per root: the caveat is useful the first time and
      // noise on every file save afterwards.
      const reachedClaudeCode = applied.some((action) =>
        action.target?.startsWith(`${CLAUDE_SKILLS_DIR}/`)
      );
      const createdTheDirectory = !claudeSkillsExisted;
      if (reachedClaudeCode && (createdTheDirectory || !restartNoteSaid.has(absRoot))) {
        restartNoteSaid.add(absRoot);
        logger.info('[HarnessSync] New skills are in place for Claude Code', {
          root: absRoot,
          restartRequired: createdTheDirectory,
          ...claudeCodeRestartNote(createdTheDirectory),
        });
      }
    } catch (err) {
      // Contained for the same reason every other trigger contains its failures:
      // this runs from a filesystem event, where a throw has nowhere to go but
      // the process-wide unhandled-rejection path.
      logger.warn('[HarnessSync] Watched projection failed (non-fatal)', {
        root: absRoot,
        trigger,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run one root's pending firing, then whatever arrived while it ran.
   *
   * Only ever reached with nothing in flight for this root, and that is one
   * place's job rather than two: {@link schedule} refuses to open a coalescing
   * window while a firing is queued or running, so a window and a firing are
   * mutually exclusive by construction. Re-checking here would be a second
   * bound on the same thing, in a spot no test can reach.
   */
  function fire(key: string): void {
    const state = states.get(key);
    if (!state) return;
    const trigger = state.trigger;
    // Assigned in the same tick the promise is created, so nothing can slip a
    // second firing for this root into the gap.
    const run = (async () => {
      try {
        await projectRoot(state.absRoot, trigger);
      } catch (err) {
        // `projectRoot` contains its own failures, so reaching this is a defect
        // in it rather than a projection that went wrong. It is caught anyway
        // because the `finally` below is what keeps the root alive: a rejection
        // that escaped here would leave `inFlight` set for ever, and every later
        // event for this repository would coalesce into a firing that never runs.
        logger.warn('[HarnessSync] Skills trigger threw outside its own guard', {
          root: state.absRoot,
          trigger,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        state.inFlight = undefined;
        if (state.again) {
          state.again = false;
          schedule(state.absRoot, trigger);
        } else if (!state.timer) {
          // Nothing is pending: drop the entry so a server that has watched a
          // thousand repos over a week holds no state when it is idle.
          states.delete(key);
        }
      }
    })();
    state.inFlight = run;
  }

  /** {@link SkillsWatcherHandle.scheduleProjection}. */
  function schedule(root: string, trigger: ProjectionTrigger): void {
    if (stopped) return;
    const key = canonicalize(root);
    const state = states.get(key) ?? { absRoot: key, again: false, trigger };
    states.set(key, state);
    // Last writer wins inside a coalescing window: a burst of events with
    // different causes becomes one firing, stamped with the most recent. That is
    // the honest reading of a coalesced projection — and it is why a test that
    // wants to attribute a firing to one trigger has to pick a trigger nothing
    // else emits, rather than assuming the stamp cannot be overwritten.
    state.trigger = trigger;
    // A firing is already queued on the lock or running: do NOT queue a second,
    // and do not open a window either. This is the queue bound —
    // `projectLockQueueDepth` never grows by more than one on the watcher's
    // account, however many events arrive — and it is also what makes `fire`
    // able to assume nothing is in flight. The flag is what stops these events
    // being dropped instead: one more projection runs once this one is done.
    if (state.inFlight) {
      state.again = true;
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      fire(key);
    }, coalesceMs);
    state.timer.unref?.();
  }

  /** {@link SkillsWatcherHandle.projectIfSkillsChanged}. */
  function projectIfSkillsChanged(root: string, trigger: ProjectionTrigger): void {
    if (stopped) return;
    const absRoot = canonicalize(root);
    const previous = shapes.get(absRoot);
    // Deliberately does NOT record what it just read. The record is what
    // "DorkOS has dealt with this" means, and only a projection that finished
    // can say that — writing it here would retire a change on the strength of
    // having NOTICED it, so a projection that then failed would never be
    // retried by anything. `projectRoot` commits the shape it planned from.
    //
    // No record at all means DorkOS has never looked at this project. Treating
    // that as "unchanged" is how the first skill of a session would be the one
    // that never arrived.
    if (previous !== undefined && previous === skillsShape(absRoot)) return;
    schedule(absRoot, trigger);
  }

  /** Catch every root up on what the watcher did not report. */
  function sweep(): void {
    for (const absRoot of roots) projectIfSkillsChanged(absRoot, 'sweep');
  }

  /**
   * Open a watch for any root whose `.agents/skills` has appeared since the last
   * look, and project what is in it.
   *
   * This is not tidiness — without it such a root is deaf for the life of the
   * process. See {@link armWatch} for what chokidar actually does with a path
   * that is not there.
   */
  function rearm(): void {
    if (stopped) return;
    for (const absRoot of roots) {
      if (watchers.has(absRoot)) continue;
      if (!armWatch(absRoot)) continue;
      projectIfSkillsChanged(absRoot, 'watch-armed');
    }
  }

  /**
   * Open one chokidar watch over a root's `.agents/skills`, if there is one to
   * open.
   *
   * **A watch on a path that does not exist is not a watch.** Measured against
   * chokidar 5 on macOS: pointed at an absent `.agents/skills`, it watches the
   * nearest EXISTING ancestor instead, emits a single raw `rename` when the
   * directory is created, and never watches the directory itself —
   * `getWatched()` still holds no entry for it ten seconds later. The root is
   * then deaf for the life of the process, which is why this answers `false`
   * rather than pretending, and why {@link rearm} exists to come back and open
   * it the moment the directory appears.
   *
   * Creating the directory here would be a write into somebody's repository
   * because a server started, which is exactly what this module does not do.
   *
   * @param absRoot - The project root, canonical and already in bounds.
   * @returns `true` when a watch is now open on the skills directory.
   */
  function armWatch(absRoot: string): boolean {
    const skillsDir = join(absRoot, AGENTS_SKILLS_DIR);
    if (!existsSync(skillsDir)) return false;
    const watcher = chokidar.watch(skillsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: SKILL_WRITE_STABILITY_MS,
        pollInterval: SKILL_WRITE_POLL_MS,
      },
    });

    const onSkillFile = (filePath: string): void => {
      if (isAuthoredSkillFile(filePath, skillsDir)) schedule(absRoot, 'skill-file');
    };
    // `addDir` is deliberately absent: a directory with no SKILL.md in it yet is
    // the first hazard, and projecting for one does nothing twice.
    watcher.on('add', onSkillFile);
    watcher.on('change', onSkillFile);
    watcher.on('unlink', onSkillFile);
    watcher.on('unlinkDir', (dirPath) => {
      if (dirname(dirPath) === skillsDir && !basename(dirPath).startsWith('.')) {
        schedule(absRoot, 'skill-dir');
      }
    });

    // Without this, a watcher failure (EMFILE when the process runs out of file
    // descriptors) has nowhere to go but the process-wide unhandled-error path.
    // Latched per error code, so a benign EACCES on one path cannot silence the
    // EMFILE storm behind it.
    const seenCodes = new Set<string>();
    watcher.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      logger.error(
        `[watcher-error] SkillsWatcher: ${skillsDir} — further ${code} errors from this watcher are suppressed`,
        {
          skillsDir,
          code,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          suppressingFurtherErrors: true,
        }
      );
    });

    // Settled either way: a watch that errors out must not leave `ready()`
    // pending for the life of the process. The settle after it is not padding —
    // measured against chokidar 5 on macOS, a file written in the instant after
    // `ready` is dropped 13-40% of the time, while the same watcher left to
    // settle for {@link SKILLS_SETTLE_MS} first missed 0 of 40. A production
    // watcher lives for hours so it is past this window immediately; what the
    // wait buys is that `ready()` means what it says.
    const ready = new Promise<void>((resolve) => {
      const settle = (): void => {
        const timer = setTimeout(resolve, settleMs);
        timer.unref?.();
      };
      watcher.on('ready', settle);
      watcher.on('error', settle);
    });
    watchers.set(absRoot, { watcher, ready });
    logger.debug('[HarnessSync] Watching for skills an agent writes', { skillsDir });
    return true;
  }

  /**
   * Bring the root set in line with the caller's current list, refusing every
   * directory the boundary does not cover.
   *
   * The refusal is here as well as in {@link projectRoot} on purpose, and they
   * are not the same check: this one stops DorkOS WATCHING a directory the
   * operator fenced off, and that one stops it WRITING into one. A root can only
   * be dropped from the watch set by the caller's list changing, so the write
   * gate has to stand on its own.
   */
  async function syncRoots(): Promise<void> {
    // Serialized, because the boundary is asked per root and the answers are
    // awaited: the five-minute rescan and a caller's own `refreshRoots()` can
    // otherwise be halfway through building their sets at the same time, each
    // closing watchers the other just opened. Chaining costs nothing when
    // nobody overlaps, which is every ordinary tick.
    syncing = syncing.then(runSyncRoots, runSyncRoots);
    return syncing;
  }

  /** One pass of {@link syncRoots}; never called concurrently with itself. */
  async function runSyncRoots(): Promise<void> {
    if (stopped) return;
    const wanted = new Set<string>();
    for (const root of opts.roots()) {
      if (root.length === 0) continue;
      const absRoot = canonicalize(root);
      if (!(await withinBoundary(absRoot))) {
        if (!refusedRoots.has(absRoot)) {
          refusedRoots.add(absRoot);
          logger.debug('[HarnessSync] Not watching a project outside the directory boundary', {
            root: absRoot,
          });
        }
        continue;
      }
      wanted.add(absRoot);
    }
    if (stopped) return;

    // Everything from here down is synchronous, and that is the point: `roots`
    // is what the sweep and the re-arm iterate, so a pass that emptied it and
    // refilled it across an `await` would leave a window in which those two
    // cover nothing at all. The new set is built above, and swapped in here.
    for (const [absRoot, entry] of watchers) {
      if (wanted.has(absRoot)) continue;
      watchers.delete(absRoot);
      void entry.watcher.close();
    }
    roots.clear();
    for (const absRoot of wanted) {
      const isNew = !shapes.has(absRoot);
      roots.add(absRoot);
      // Seeded when the root is TAKEN ON, not when a watch opens on it, and the
      // difference is the whole of the deaf-root case. Seeded at arm time, a
      // root whose `.agents/skills` appears later has its very first skill
      // written down as "what was already here" the instant the watch opens —
      // so the re-arm finds nothing changed and that skill is never projected.
      // Seeded here it is `-`, and the directory appearing is a change.
      if (isNew) shapes.set(absRoot, skillsShape(absRoot));
      if (!watchers.has(absRoot)) armWatch(absRoot);
    }
  }

  const firstSync = syncRoots();
  const rescan = setInterval(() => void syncRoots(), opts.rootRescanMs ?? SKILLS_ROOT_RESCAN_MS);
  rescan.unref?.();
  const sweepMs = opts.sweepMs ?? SKILLS_SWEEP_MS;
  const sweeper = sweepMs > 0 ? setInterval(sweep, sweepMs) : undefined;
  sweeper?.unref?.();
  const rearmMs = opts.rearmMs ?? SKILLS_REARM_MS;
  const rearmer = rearmMs > 0 ? setInterval(rearm, rearmMs) : undefined;
  rearmer?.unref?.();

  /** Every open watch's first scan, plus the settle that makes it trustworthy. */
  const watchesLive = async (): Promise<void> => {
    await firstSync;
    await Promise.all([...watchers.values()].map((entry) => entry.ready));
  };

  return {
    scheduleProjection: schedule,
    projectIfSkillsChanged,
    refreshRoots: syncRoots,
    watchedRoots: () => [...watchers.keys()],
    ready: watchesLive,
    async flush(): Promise<void> {
      // A barrier is only a barrier if nothing is still arriving behind it.
      await watchesLive();
      for (;;) {
        let progressed = false;
        for (const [key, state] of [...states]) {
          if (state.timer === undefined) continue;
          clearTimeout(state.timer);
          state.timer = undefined;
          fire(key);
          progressed = true;
        }
        const running = [...states.values()]
          .map((state) => state.inFlight)
          .filter((p): p is Promise<void> => p !== undefined);
        if (running.length === 0 && !progressed) return;
        await Promise.all(running);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(rescan);
      if (sweeper) clearInterval(sweeper);
      if (rearmer) clearInterval(rearmer);
      roots.clear();
      const running: Promise<void>[] = [];
      for (const state of states.values()) {
        if (state.timer) clearTimeout(state.timer);
        if (state.inFlight) running.push(state.inFlight);
      }
      states.clear();
      const closing = [...watchers.values()].map((entry) => entry.watcher.close());
      watchers.clear();
      await Promise.all([...closing, ...running]);
    },
  };
}

/** What {@link startTurnEndReprojection} needs to know. */
export interface TurnEndReprojectionOptions {
  /**
   * The live watcher, whose coalescing, lock bound and record of what each
   * project's skills last looked like this shares.
   */
  watcher: Pick<SkillsWatcherHandle, 'projectIfSkillsChanged'>;
  /**
   * Subscribe to session turn boundaries; returns an unsubscribe function.
   *
   * Injected rather than imported so this is testable without a projector, a
   * runtime or a session — and so the harness domain does not reach into the
   * session domain for a side effect.
   */
  subscribe: (listener: (sessionId: string, kind: TurnBoundaryKind) => void) => () => void;
  /**
   * Where a session's turn ran, or `undefined` when nothing knows.
   *
   * Today that is the runtime's own live binding (`AgentRuntime.getSessionCwd`),
   * which claude-code is the sole implementor of, reached through the session's
   * bound runtime rather than by asking every registered one. See the residual
   * in {@link startTurnEndReprojection}.
   */
  rootForSession: (sessionId: string) => Promise<string | undefined>;
}

/** What {@link startTurnEndReprojection} answers. */
export interface TurnEndReprojection {
  /** Stop listening for turn boundaries. */
  stop(): void;
  /**
   * Resolve once every turn this hook is still placing has been placed.
   *
   * The listener detaches its work — it runs inside the projector's event
   * ingest, which must not be held up — so "the turn ended" and "the projection
   * was scheduled" are two different moments. This is the barrier between them.
   *
   * @internal Exported for testing only; nothing in the server waits on it.
   */
  settled(): Promise<void>;
}

/**
 * Re-project the project a turn ran in, when that turn changed which skills the
 * project has (contract TR-07).
 *
 * ## What it adds over the watcher
 *
 * The watcher covers a fixed set of roots. This covers the project a session was
 * actually pointed at — a person's own checkout, a room worktree, anything the
 * watcher has no reason to be watching — and it is the only trigger that does.
 *
 * ## How "the turn touched the skills" is decided
 *
 * By comparing the shape of `.agents/skills` against what DorkOS recorded last,
 * not by reading the turn's tool calls. Tool-call paths are each runtime's own
 * shape and are not uniformly observable across the three of them, while one
 * `readdir` answers the question that actually matters: has the SET of skills
 * changed? An edit to a `SKILL.md` that is already linked does not move it, and
 * needs no new projection — the link already points at the file.
 *
 * The comparison is the WATCHER's, shared rather than kept here, which is what
 * makes the two triggers agree about a project both can see. `.claude/skills` is
 * deliberately not part of the shape, and including it was a real bug rather
 * than an untidiness: the projection WRITES there, so every firing moved the
 * very number the next turn compared against, and each turn end projected again
 * for ever. It would also buy nothing — a skill an agent writes straight into
 * `.claude/skills` is an adoptable asset for `dorkos harness adopt` to move, not
 * something a projection propagates (SRC-07, J-06).
 *
 * The first turn in a project DorkOS has never looked at projects
 * unconditionally: there is no recorded shape to compare against, and refusing
 * to act on that would mean the first skill of every session was the one that
 * never arrived. It costs one plan and apply per project per process, it is
 * idempotent, and — like every other firing — it is refused outright for a
 * project with no harness manifest.
 *
 * ## The residual, stated
 *
 * `getSessionCwd` is implemented by claude-code alone, so a Codex or OpenCode
 * session in a directory the watcher does not watch reaches neither trigger.
 * That is narrower than it sounds — Claude Code is the only harness that needs
 * the projection at all, since the other five read `.agents/skills` natively —
 * but it is a gap, and closing it means recording the turn's directory where it
 * is resolved rather than asking a runtime for it afterwards.
 *
 * @param opts - The watcher to schedule on, the boundary subscription, and the
 *   session-to-project resolver.
 * @returns A handle that unsubscribes, and can be waited on.
 */
export function startTurnEndReprojection(opts: TurnEndReprojectionOptions): TurnEndReprojection {
  /** Placements in flight, so {@link TurnEndReprojection.settled} can wait for them. */
  const placing = new Set<Promise<void>>();

  const unsubscribe = opts.subscribe((sessionId, kind) => {
    // A turn that ENDED, and nothing else. `interaction_resolved` is a person
    // answering a prompt mid-turn — the runtime is still writing, which is the
    // one moment a projection must not run.
    if (kind !== 'turn_end') return;
    // Detached, and it has to be: this runs inside the projector's event
    // ingest, where anything awaited would hold up the turn's own stream. The
    // work it starts is bounded by the watcher's coalescing and its lock.
    const placement = (async () => {
      try {
        const root = await opts.rootForSession(sessionId);
        if (root === undefined || root.length === 0) return;
        opts.watcher.projectIfSkillsChanged(root, 'turn-end');
      } catch (err) {
        logger.warn('[HarnessSync] Could not place a finished turn (non-fatal)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    placing.add(placement);
    void placement.finally(() => placing.delete(placement));
  });

  return {
    stop: unsubscribe,
    async settled(): Promise<void> {
      // A placement can start another only through the watcher, never through
      // this set, so one drain is enough — but the loop costs nothing and says
      // so without the reader having to work it out.
      while (placing.size > 0) await Promise.all([...placing]);
    },
  };
}
