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
import { recordHookApproval, type HookProjectionRequest } from './hook-consent.js';
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
   */
  reproject: () => void;
}

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
  return withheld.map(({ request }) => request).filter(mayAskAboutHooks);
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
  const askable = hookPackagesToAskAbout(withheld);
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
  opts.reproject();

  return { askedAbout, granted: allowed.map(({ packageName }) => packageName) };
}
