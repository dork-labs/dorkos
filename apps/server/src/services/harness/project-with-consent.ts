/**
 * The one place a projection is built and applied — with consent already
 * applied to it (contract D5, HK-07).
 *
 * ## Why this is a seam and not a helper
 *
 * A package's hooks are shell commands a harness runs unattended, so they
 * project only for packages a person has allowed (DOR-522). That gate used to
 * live inside `runAutoProjection`, whose shape is "a marketplace package
 * changed": it takes a package name and an install/uninstall action, checks
 * `harness.autoSync`, scaffolds a manifest, and asks. None of that is true of
 * the other triggers. `dorkos harness sync --fix` has no package and nobody to
 * ask; the `.agents/skills` watcher (DOR-1850) has neither, and must not sweep.
 * Each of them reaching for `project()` directly is how a trigger ends up
 * installing hooks nobody allowed — which is exactly what the CLI did.
 *
 * So the consent-carrying half is here, and every trigger calls it.
 * `__tests__/project-seam-guard.test.ts` holds that line: this is the
 * only non-test module in `apps/server/src` or `packages/cli/src` allowed to
 * call `project(` from `@dorkos/harness`.
 *
 * ## What it does and deliberately does not do
 *
 * It partitions every hook-declaring package into refused / approved / unasked
 * — **in that order**, so a file that somehow says both withholds rather than
 * installs, and everything is withheld when the file could not be read at all —
 * builds the plan with only the approved packages' hooks in it,
 * applies it, and reports what was withheld and why. It does NOT ask, scaffold a manifest, check
 * `harness.autoSync`, or log — those belong to the trigger, and folding any of
 * them in here is what made the previous version unusable by anything else.
 *
 * ## `sweepOrphans` has no default, on purpose
 *
 * The sweep prunes projections whose source is gone, and getting it wrong in
 * either direction is a real fault: an install path that omits it leaves an
 * uninstalled package's files behind, and a watcher that passes it deletes
 * whatever the plan does not currently name — on a tree that is mid-edit. So it
 * is a required field with no default, and a caller has to have an opinion.
 *
 * ## Why the plan is filtered, and why the sweep is still safe
 *
 * The engine warns that `sweepOrphans` wants a full, unfiltered plan. That
 * warning is about a HARNESS-scoped filter: a plan built for one harness omits
 * another harness's live projections, and the sweep would read them as orphans.
 * The consent filter is PACKAGE-scoped and removes only hook contributions, so
 * what the sweep sees missing is a withheld package's hooks — its managed
 * entries in `.claude/settings.local.json`, and the generated per-harness hooks
 * files that held nothing else. That is the correct fail-closed withdrawal, not
 * collateral damage: commands nobody has allowed do not stay behind in a file an
 * agent reads. They come back the moment the person says yes.
 *
 * A harness filter is a different matter, and {@link projectWithConsent} refuses
 * to combine one with a sweep rather than trusting the caller to remember.
 *
 * ## Two projections into one repo: what is guaranteed
 *
 * Three things hold, and one deliberately does not (contract AP-10, DOR-1854).
 *
 * 1. **No file is ever seen half-written.** Every generated file, scaffold,
 *    settings merge and ownership sidecar is written to a temp file and renamed
 *    over its target (`@dorkos/harness`'s `apply/atomic-write.ts`), so a harness
 *    reading `.codex/hooks.json` while a sync rewrites it gets the whole old file
 *    or the whole new one.
 * 2. **Two projections into one repo IN THIS PROCESS take turns.**
 *    {@link withProjectLock} serializes them per repository, which matters
 *    because a projection is not one synchronous act: `runAutoProjection` builds
 *    and applies a plan, AWAITS a person's answer about a package's hooks, then
 *    projects again. Without the lock a second install's whole projection could
 *    run inside that gap.
 * 3. **The end state converges anyway.** The engine's output is deterministic —
 *    two applies of the same plan write identical bytes — so whichever writer
 *    renames last leaves the same tree.
 *
 * **Not guaranteed: two PROCESSES.** The server's projection and a
 * `dorkos harness sync --fix` in a terminal, or two DorkOS instances on one repo
 * (the dev server on :6242 and the built app on :4242), are not serialized at
 * all. Nothing here takes a lock FILE, and that is a decision rather than an
 * omission: a lock file needs a stale-lock story — which pid, on which host,
 * after which crash — and the CLI half runs offline with nobody to ask. Atomic
 * writes plus deterministic bytes give the property AP-10 actually needs (every
 * file a harness reads is complete, and the end state is the sequential one), so
 * the lock would buy only the residual below.
 *
 * That residual, stated plainly: two processes applying DIFFERENT plans to one
 * repo in the same instant can interleave a generated hooks file's two writes —
 * the file, then its ownership sidecar — so that the sidecar ends up describing
 * the other process's bytes. DOR-1842's rule then reads the pair as a file
 * somebody edited by hand and reports a conflict naming the way out, which is
 * the safe answer and a wrong one. It needs both processes to write different
 * bytes within microseconds of each other, and the way out is the same as for a
 * real hand edit: delete the file and re-run.
 *
 * @module services/harness/project-with-consent
 */
import {
  applyPlan as defaultApplyPlan,
  project as defaultProject,
  projectedHooks as defaultProjectedHooks,
  scanInstalledPlugins as defaultScanInstalledPlugins,
  type HarnessId,
  type ProjectionAction,
  type ProjectionPlan,
} from '@dorkos/harness';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isHookProjectionApproved,
  isHookProjectionRefused,
  storedHookDecisions,
  type HookDecisions,
  type HookProjectionRequest,
} from './hook-consent.js';

/**
 * Seam for the Harness Sync engine calls, injectable so route/service tests can
 * exercise the gating logic without touching the real filesystem or git. The
 * defaults are the real `@dorkos/harness` exports.
 *
 * @internal Exported for testing only.
 */
export const _internal = {
  project: defaultProject,
  applyPlan: defaultApplyPlan,
  scanInstalledPlugins: defaultScanInstalledPlugins,
  projectedHooks: defaultProjectedHooks,
};

/**
 * Why a package's hooks did not project.
 *
 * `unreadable-config` is not a decision at all: it means the file the decisions
 * live in could not be read, so nothing is known about this package and nothing
 * is going to be installed on a guess. It is kept distinct from `unasked`
 * because the two need opposite advice — one says "allow it", the other says
 * "fix your settings file first, and do NOT run the command that opens it".
 */
export type WithheldReason = 'refused' | 'unasked' | 'unreadable-config';

/** One package whose hooks were left out of the plan, and what they were. */
export interface WithheldHooks {
  /** The stored decision this package is under, or its absence. */
  reason: WithheldReason;
  /** The package, project and exact hooks — enough to ask about, or to record a yes for. */
  request: HookProjectionRequest;
  /** Why the settings file could not be read, when {@link reason} says so. */
  unreadable?: string;
}

/**
 * One promise chain per repository: what a caller must wait on before its own
 * turn, keyed by the realpath of the project root.
 *
 * An entry is removed once nothing is queued behind it, so a server that has
 * projected into a thousand repos over a week holds no locks at all when it is
 * idle.
 */
const projectLocks = new Map<string, Promise<void>>();

/**
 * The key two callers must agree on to be talking about the same repository.
 *
 * Realpath, because `/var/folders/…` and `/private/var/folders/…` are one
 * directory on macOS and a worktree is routinely reached through a symlinked
 * path — two callers naming it differently would each take their own lock and
 * serialize nothing. A path that does not exist yet (or cannot be resolved)
 * falls back to its absolute form, which is still stable for one process.
 */
function projectLockKey(projectPath: string): string {
  try {
    return realpathSync(projectPath);
  } catch {
    return resolve(projectPath);
  }
}

/**
 * Run `fn` with no other projection into the same repository running in this
 * process.
 *
 * A projection is not one synchronous act. `runAutoProjection` applies a plan,
 * AWAITS a person's answer about a package's hooks, and applies again; the
 * `.agents/skills` watcher (DOR-1850) will call the seam at file-event
 * frequency. Both of those can overlap another install's passes into the same
 * repo, and the two would then be reading each other's half-finished view of the
 * tree. This makes them take turns instead.
 *
 * Different repositories never wait on each other. A thrown or rejecting `fn`
 * releases the lock exactly like a successful one, so one failure cannot wedge a
 * repository for the life of the process.
 *
 * This is the IN-PROCESS half only; the module docs above state what happens
 * between processes, and why nothing here takes a lock file.
 *
 * @param projectPath - The project root the work is about.
 * @param fn - The work to run under the lock.
 * @returns Whatever `fn` returns, once its turn has come and gone.
 */
export function withProjectLock<T>(projectPath: string, fn: () => T | Promise<T>): Promise<T> {
  const key = projectLockKey(projectPath);
  // `prior` is always a settled-either-way promise (see `released`), so a
  // failing turn can never reject the turn queued behind it.
  const prior = projectLocks.get(key) ?? Promise.resolve();
  const turn = prior.then(fn);
  const released = turn.then(
    () => undefined,
    () => undefined
  );
  projectLocks.set(key, released);
  void released.then(() => {
    // Only the LAST holder clears the entry: if somebody chained on behind us,
    // the map already points at their release and must keep doing so.
    if (projectLocks.get(key) === released) projectLocks.delete(key);
  });
  return turn;
}

/**
 * How many repositories currently have a projection queued or running.
 *
 * @returns The number of live lock entries.
 * @internal Exported so a test can assert the map does not grow without bound.
 */
export function projectLockCount(): number {
  return projectLocks.size;
}

/** Options for {@link planWithConsent} and {@link projectWithConsent}. */
export interface ProjectWithConsentOptions {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /**
   * The stored decisions to obey. Defaults to the running server's config store;
   * `dorkos harness sync --check` passes a copy read straight off `config.json`,
   * because opening the store would write one (see `hook-consent.ts`).
   */
  decisions?: HookDecisions;
  /** Narrow every projection, drop and warning to one harness before applying. */
  harness?: HarnessId;
}

/** What {@link planWithConsent} answers. */
export interface ConsentedPlan {
  /** The plan, with only allowed packages' hooks in it. */
  plan: ProjectionPlan;
  /** Every hook-declaring package left out of it, with the reason. */
  withheld: WithheldHooks[];
}

/** What {@link projectWithConsent} answers: the plan, plus what applying it did. */
export interface ProjectWithConsentResult extends ConsentedPlan {
  /** Projections realized on disk. */
  applied: ProjectionAction[];
  /** Projections a file DorkOS does not own is blocking. */
  conflicts: ProjectionAction[];
  /** Repo-relative paths pruned because what they came from is gone. */
  swept: string[];
  /** Repo-relative hooks files DorkOS did not write and stepped over. */
  leftAlone: string[];
}

/**
 * Every hook-declaring package in the project, as a request that can be
 * digested, asked about, or recorded.
 *
 * Scanning the plugins rather than reading them back off the plan is deliberate:
 * the Claude Code settings merge is the only place the plan names packages
 * individually, and it is absent when a project does not sync to Claude Code —
 * yet those projects still get the same commands in their generated Codex hooks
 * file. The question is about packages, so it is asked of the packages.
 *
 * Read fresh on every call, never cached across an approval wait: a package
 * whose `hooks.json` is rewritten while its card sits unanswered produces a
 * different digest, and so is not allowed by the yes that was given.
 *
 * @param projectPath - The project root being projected into.
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns One request per hook-declaring package, in scan order.
 */
export function scanHookRequests(projectPath: string, dorkHome: string): HookProjectionRequest[] {
  const plugins = _internal.scanInstalledPlugins({ dorkHome, projectRoot: projectPath });
  return _internal
    .projectedHooks(plugins, projectPath)
    .map(({ packageName, hooks }) => ({ projectPath, packageName, hooks }));
}

/**
 * Build the projection plan for a project with every unapproved package's hooks
 * left out of it, and report what was left out.
 *
 * Read-only: nothing here touches disk beyond the reads the engine already does
 * to plan.
 *
 * @param projectPath - The project root being projected into.
 * @param opts - Dork home, the decisions to obey, and an optional harness filter.
 * @returns The consented plan and the withheld packages.
 */
export function planWithConsent(
  projectPath: string,
  opts: ProjectWithConsentOptions
): ConsentedPlan {
  const decisions = opts.decisions ?? storedHookDecisions();
  const allowed = new Set<string>();
  const withheld: WithheldHooks[] = [];
  for (const request of scanHookRequests(projectPath, opts.dorkHome)) {
    // REFUSAL IS TESTED FIRST, and the order is the whole of it. Recording
    // either decision clears the other, so no code path puts one entry in both
    // lists — but both leaves are `operator-only` exactly so a person can edit
    // `~/.dork/config.json` by hand, and a hand-edit is how a file ends up
    // saying two things at once. Testing approval first let the approve branch
    // win, so a command somebody had turned down installed itself with no
    // withheld block: the one reading where the safe answer and the loud answer
    // are the same answer.
    if (decisions.unreadable !== undefined) {
      // The lists are empty because the FILE could not be read, not because
      // nobody has decided. Saying "you have not allowed this yet" here would be
      // the opposite of the truth for anybody who had.
      withheld.push({ reason: 'unreadable-config', request, unreadable: decisions.unreadable });
    } else if (isHookProjectionRefused(request, decisions)) {
      withheld.push({ reason: 'refused', request });
    } else if (isHookProjectionApproved(request, decisions)) {
      allowed.add(request.packageName);
    } else {
      withheld.push({ reason: 'unasked', request });
    }
  }

  const full = _internal.project(projectPath, {
    dorkHome: opts.dorkHome,
    allowPluginHooks: (name) => allowed.has(name),
  });
  const plan = opts.harness === undefined ? full : filterPlanToHarness(full, opts.harness);
  return { plan, withheld };
}

/**
 * Narrow a plan to a single harness, preserving action object identity so the
 * content side-table (`getActionContent`) keeps resolving for scaffold/generate.
 *
 * A harness-agnostic entry survives every filter: a plugin layer that has no
 * home in any harness, and a hook declaration the reader could not use, are not
 * answers about one harness, and hiding them behind `--harness cursor` is how
 * they went unreported (contract VC-02).
 */
function filterPlanToHarness(plan: ProjectionPlan, harness: HarnessId): ProjectionPlan {
  return {
    actions: plan.actions.filter((a) => a.harness === harness),
    drops: plan.drops.filter((a) => a.harnessAgnostic === true || a.harness === harness),
    warnings: plan.warnings.filter((w) => w.harnessAgnostic === true || w.harness === harness),
    // A harness that is not the one asked about is not an answer to the
    // question, exactly like every other line of a narrowed report: `--harness
    // codex` should not mention Cursor.
    notEnabled: plan.notEnabled.filter((d) => d.harness === harness),
  };
}

/**
 * Build the consented plan and realize it on disk.
 *
 * @param projectPath - The project root being projected into.
 * @param opts - Dork home, the sweep decision, the decisions to obey, and an
 *   optional harness filter.
 * @returns The plan, what applying it did, and the withheld packages.
 * @throws When a harness filter is combined with the orphan sweep — a filtered
 *   plan omits other harnesses' live projections, and the sweep would read them
 *   as orphans and delete them.
 */
export function projectWithConsent(
  projectPath: string,
  opts: ProjectWithConsentOptions & { sweepOrphans: boolean }
): ProjectWithConsentResult {
  if (opts.sweepOrphans && opts.harness !== undefined) {
    throw new Error(
      'projectWithConsent: sweepOrphans cannot run on a plan narrowed to one harness — ' +
        'the sweep would read every other harness’s live projection as an orphan.'
    );
  }
  const { plan, withheld } = planWithConsent(projectPath, opts);
  const { applied, conflicts, swept, leftAlone } = _internal.applyPlan(projectPath, plan, {
    sweepOrphans: opts.sweepOrphans,
  });
  return { plan, withheld, applied, conflicts, swept, leftAlone };
}
