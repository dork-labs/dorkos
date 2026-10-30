/**
 * Ask a person about the packages whose hooks a projection left out, record the
 * answers, and hand the re-projection back to whoever asked (spec
 * `harness-sync-status` §2.2.2, Decision 11).
 *
 * ## Why this is its own module and not a second `*WithConsent`
 *
 * `project-with-consent.ts` is the only non-test module allowed to call the
 * engine's `project()`, and the reason it gives is that every new trigger
 * reaching for its own projection is how hooks nobody allowed get installed. A
 * `syncWithConsent` beside it would either duplicate the seam or route around
 * it.
 *
 * This half is not projection. It raises cards, records answers and calls back;
 * it builds no plan and touches no target. So extracting it moves nothing across
 * the guarded line, and `__tests__/project-seam-guard.test.ts` passes with an
 * unchanged allowlist.
 *
 * ## Two callers, one sequence, two re-projections
 *
 * `runAutoProjection` (a marketplace package changed) and `POST /api/harness/sync`
 * (a person clicked Sync now) ask the same question in the same order, and each
 * has its own second pass to run afterwards: the trigger logs a package name and
 * an install/uninstall action, the route sweeps orphans and recomputes a status.
 * Neither belongs here, so {@link AskAboutWithheldHooksOptions.reproject} is what
 * the caller supplies and this module never decides.
 *
 * ## The route does not wait, and that is why the selector is exported
 *
 * `askAboutWithheldHooks` stays unresolved while a card is on screen — up to the
 * approval window — which is why the install route treats it as fire-and-forget
 * and why the sync route does too. A button that hangs on a modal is worse than
 * one that returns and says what is waiting. But the route still has to name the
 * packages it just raised a card for, so {@link hookPackagesToAskAbout} is
 * public: the route asks it, then fires this without awaiting, and the two
 * answers are the same answer because nothing awaits between them.
 *
 * @module services/harness/ask-withheld-hooks
 */
import {
  askForHookProjection,
  mayAskAboutHooks,
  type HookApprovalGateway,
} from './hook-approval.js';
import {
  isHookProjectionRefused,
  recordHookApproval,
  type HookProjectionRequest,
} from './hook-consent.js';
import {
  dropPassiveHookRow,
  forgetPassiveHookRow,
  readPassiveHookRows,
  rememberPassiveHookRow,
} from './passive-hook-rows.js';
import { logger } from '../../lib/logger.js';
import type { WithheldHooks } from './project-with-consent.js';

/** What {@link askAboutWithheldHooks} needs from its caller. */
export interface AskAboutWithheldHooksOptions {
  /** The project the cards are about — for the summary log line. */
  projectPath: string;
  /** The approval primitive that raises the cards and reports the answers. */
  approvals: HookApprovalGateway;
  /**
   * Re-project once at least one card is granted. The caller owns the sweep
   * decision and the logging.
   *
   * It runs only when something was allowed, because the first pass already
   * wrote everything else: with nothing granted, a second pass would write the
   * same bytes for nothing.
   *
   * It may answer what the second pass withheld. After a passive row's yes,
   * {@link raisePassiveHookRows} raises the row for anything still held back:
   * a yes given for files the package has since changed covers only those
   * files, so the row for today's files is the one left (DOR-3433).
   */
  reproject: () => void | Reprojected | Promise<void | Reprojected>;
  /**
   * The DorkOS data directory. When given, each passive row's request is saved
   * there so a yes given after a restart still lands (`passive-hook-rows.ts`).
   */
  dorkHome?: string;
}

/** What a re-projection may answer: the packages it still held back. */
export type Reprojected = readonly WithheldHooks[];

/** What {@link askAboutWithheldHooks} answers. */
export interface AskAboutWithheldHooksResult {
  /** Package names a card was raised for, in the order they were raised. */
  askedAbout: string[];
  /** Package names a person allowed. */
  granted: string[];
}

/**
 * The packages a card would be new information about.
 *
 * A package a person has already turned down is not asked again, and one with a
 * card already open does not get a second; both stay withheld either way, and
 * what is dropped is the repetition — which would otherwise fire on every later
 * install AND on uninstalls (`mayAskAboutHooks`).
 *
 * Exported because the sync route needs the ANSWER without waiting for the
 * cards: it reads this, then fires {@link askAboutWithheldHooks} without
 * awaiting it. That function re-runs this before its first `await`, so the two
 * calls see one state and cannot disagree.
 *
 * @param withheld - Every package the projection left hooks out for.
 * @returns The requests worth putting in front of a person, in scan order.
 */
export function hookPackagesToAskAbout(
  withheld: readonly WithheldHooks[]
): HookProjectionRequest[] {
  // A package no yes could make run is never put to a person (`unpinnable`).
  return withheld
    .filter(({ unpinnable }) => unpinnable !== true)
    .map(({ request }) => request)
    .filter(mayAskAboutHooks);
}

/**
 * Raise one card per withheld package, wait for the answers, record every yes,
 * and re-project once if anybody said one.
 *
 * All the cards go up before any is awaited, so a person sees everything that is
 * waiting instead of one card at a time.
 *
 * The record is written BEFORE the re-projection, because it is what stops the
 * next projection asking again and it must survive a failure in the apply. The
 * re-projection re-reads the packages from disk, so a package that rewrote its
 * `hooks.json` while its card was open no longer matches what was approved and
 * stays withheld.
 *
 * @param withheld - Every package the projection left hooks out for.
 * @param opts - The project, the approval primitive, and the caller's second pass.
 * @returns What was asked about and what was allowed.
 */
export async function askAboutWithheldHooks(
  withheld: readonly WithheldHooks[],
  opts: AskAboutWithheldHooksOptions
): Promise<AskAboutWithheldHooksResult> {
  // Synchronous, and deliberately before the first `await`: a caller that read
  // `hookPackagesToAskAbout` itself and then fired this without awaiting must
  // get the same list, and an `await` here is all it would take to break that.
  // A package Full held back is not asked about here: its passive row is
  // raised by `raisePassiveHookRows`, which nothing waits on (DOR-3427).
  const passive = passiveRequests(withheld);
  const askable = hookPackagesToAskAbout(withheld).filter((request) => !passive.has(request));
  const askedAbout = askable.map(({ packageName }) => packageName);
  if (askable.length === 0) return { askedAbout, granted: [] };

  const gateway = opts.approvals;
  const decisions = await Promise.all(
    askable.map(async (request) => ({
      request,
      granted: await askForHookProjection(gateway, request),
    }))
  );
  const allowed = decisions.filter((decision) => decision.granted).map((d) => d.request);

  logger.info('[HarnessSync] Asked about a package’s hooks', {
    projectPath: opts.projectPath,
    askedAbout,
    granted: allowed.map(({ packageName }) => packageName),
  });

  if (allowed.length === 0) return { askedAbout, granted: [] };

  for (const request of allowed) recordHookApproval(request);
  await opts.reproject();

  return { askedAbout, granted: allowed.map(({ packageName }) => packageName) };
}

/** The withheld requests that are passive rows: packages Full held back (DOR-3427). */
function passiveRequests(withheld: readonly WithheldHooks[]): Set<HookProjectionRequest> {
  return new Set(withheld.filter((w) => w.notInstalledByDorkos).map(({ request }) => request));
}

/**
 * Raise the passive row under Needs you for each package Full held back because
 * DorkOS did not install it (DOR-3427), and act on the answer whenever it comes.
 *
 * Nothing waits on these, and that is the whole difference from
 * {@link askAboutWithheldHooks}: this returns at once, each row's wait has no
 * deadline (the row never expires), and a yes records the decision and calls
 * `reproject` on its own. So a caller must call it OUTSIDE any project lock and
 * hand it a `reproject` that takes the lock itself: a wait that never ends must
 * not hold a repository. One row per package: a row already open in this process
 * is not raised again (`mayAskAboutHooks`), one left open across a restart is
 * picked up again (`reissue`), and one for files the package has since changed
 * is closed when the row for today's files goes up (DOR-3433). A yes that
 * turns out stale leaves the package withheld and raises its row again, quietly.
 *
 * @param withheld - Every package the projection left hooks out for.
 * @param opts - The project, the approval primitive, and a lock-taking re-projection.
 * @returns The package names a row was raised or picked up for.
 */
export function raisePassiveHookRows(
  withheld: readonly WithheldHooks[],
  opts: AskAboutWithheldHooksOptions
): string[] {
  const passive = passiveRequests(withheld);
  const rows = hookPackagesToAskAbout(withheld).filter((request) => passive.has(request));
  for (const request of rows) followPassiveRow(request, opts, false);
  return rows.map(({ packageName }) => packageName);
}

/**
 * Pick up, after a restart, the passive rows whose tickets are still open, so a
 * yes given then records and projects instead of being lost until the next sync.
 *
 * Each row is rebuilt from the request it was raised for and waits on that
 * ticket only (`resumeOnly`): it never raises a new one, and a row whose ticket
 * is gone is dropped. A yes the person gave while nobody was waiting is found on
 * the first check and spent once, like any other. A package turned down since is
 * not picked up.
 *
 * @param opts - The data directory, the approval primitive, and a lock-taking
 *   re-projection for the row's project.
 * @returns The package names picked up.
 */
export function resumePassiveHookRows(opts: {
  dorkHome: string;
  approvals: HookApprovalGateway;
  reproject: (request: HookProjectionRequest) => Promise<void | Reprojected>;
}): string[] {
  const picked: string[] = [];
  for (const request of readPassiveHookRows(opts.dorkHome)) {
    // One row at a time, each on its own: this runs while the server starts, so
    // a row nothing can make sense of is logged and dropped, never thrown.
    try {
      if (!mayAskAboutHooks(request)) {
        if (isHookProjectionRefused(request)) forgetPassiveHookRow(opts.dorkHome, request);
        continue;
      }
      followPassiveRow(
        request,
        {
          projectPath: request.projectPath,
          approvals: opts.approvals,
          dorkHome: opts.dorkHome,
          reproject: () => opts.reproject(request),
        },
        true
      );
      picked.push(request.packageName);
    } catch (err) {
      logger.warn('[HarnessSync] A saved quiet row could not be picked up; dropping it', {
        projectPath: request.projectPath,
        packageName: request.packageName,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        dropPassiveHookRow(opts.dorkHome, request);
      } catch {
        // Already logged; the row is ignored on the next start either way.
      }
    }
  }
  return picked;
}

/** Wait on one passive row, and act on a yes for exactly what it was raised for. */
function followPassiveRow(
  request: HookProjectionRequest,
  opts: AskAboutWithheldHooksOptions,
  resumeOnly: boolean
): void {
  const { dorkHome } = opts;
  // A failed save never stops the row: only a yes given after a restart would
  // then wait for the next sync, as it did before rows were saved.
  const saved = (write: (home: string, row: HookProjectionRequest) => void): void => {
    if (dorkHome === undefined) return;
    try {
      write(dorkHome, request);
    } catch (err) {
      logger.warn('[HarnessSync] A held-back package’s saved row could not be updated', {
        projectPath: opts.projectPath,
        packageName: request.packageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  if (!resumeOnly) saved(rememberPassiveHookRow);
  void askForHookProjection(opts.approvals, request, { notInstalledByDorkos: true, resumeOnly })
    .then(async (granted) => {
      // The wait is over whatever the answer, so the saved row goes.
      saved(forgetPassiveHookRow);
      // A no on record for these commands wins over a yes on an old ticket.
      if (!granted || isHookProjectionRefused(request)) return;
      recordHookApproval(request);
      const still = await opts.reproject();
      if (still) raisePassiveHookRows(still, opts);
    })
    .catch((err: unknown) => {
      logger.warn('[HarnessSync] A held-back package’s row could not be followed up', {
        projectPath: opts.projectPath,
        packageName: request.packageName,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
