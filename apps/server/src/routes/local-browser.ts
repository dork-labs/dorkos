/** Human browser setup and controls. Agent actions travel through the capability gate. */
import type { BrowserViewerRegistry } from '../services/session/browser-viewers/viewer-registry.js';
import { BrowserViewerError } from '../services/session/browser-viewers/viewer-contract.js';
import { viewerSecretSchema } from '@dorkos/shared/browser-viewer-control';
import { browserViewerPrincipal } from '../services/session/browser-viewers/viewer-person.js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  LocalBrowserHandoffAnswerSchema,
  LocalBrowserHistoryDirectionSchema,
  LocalBrowserOpenSchema,
  LocalBrowserSignInDoneSchema,
  LocalBrowserSignInRequestSchema,
} from '@dorkos/shared/local-browser';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import { honoRequestFacts } from '../http/request-facts.js';
import { refuseUnlessAccountOwner, requirePersonAtThisComputer } from '../lib/caller-authority.js';
import {
  LocalBrowserError,
  type LocalBrowserService,
} from '../services/session/local-browser/service.js';
import { decideSessionGate } from '../services/core/auth/session-gate.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { mountLocalBrowserProfileRemoval } from './local-browser-profile-removal.js';
import {
  mountLocalBrowserProfileRoutes,
  type LocalBrowserProfileRouteDeps,
} from './local-browser-profiles.js';

/**
 * The browser refusals whose words name a page or a site (a page's title, the
 * host it moved to), and the fixed sentence an answer carries instead: text a
 * page controls never rides in a problem's `detail` (DOR-4979 review). A test
 * fails when a new refusal builds its words from a template and is not here.
 */
export const PAGE_WORDED_REFUSALS: Readonly<Record<string, string>> = {
  load_failed: 'The page didn’t load. Read the page again.',
  site_changed: 'The page moved to another site. Check the browser, then try again.',
};

/**
 * The browser refusals a reader acts on, by the code each goes out as: a
 * sign-in to finish, a Back or Forward the browser would not take, and the
 * page (or the profiles folder) changing since the person last looked. Every
 * other browser refusal is a `conflict`, its sentence the whole message.
 */
const BROWSER_PROBLEM_CODES: Readonly<Record<string, ProblemCode>> = {
  signing_in: 'signing_in',
  history_refused: 'history_refused',
  stale_page: 'precondition_failed',
  history_changed: 'precondition_failed',
  profiles_folder_changed: 'precondition_failed',
};

/**
 * What a person is told for each browser refusal, where the browser's own
 * words are written for the agent that drives it, or say less than a person
 * needs.
 */
const PERSON_WORDS: Readonly<Record<string, string>> = {
  stale_page: 'Page changed. Read it again before continuing.',
  navigation_uncertain: 'Check what happened before continuing.',
  navigation_unreachable: 'Couldn’t reach that site. Check the address and try again.',
  navigation_timed_out: 'That site didn’t respond. Try again in a moment.',
  uncertain: 'Check what happened before continuing.',
  paused: 'Agent paused. Resume when ready.',
  profile_busy: 'Close the Agent browser and finish signing in, then try again.',
  profile_not_found: 'Those sign-ins are already gone. Refresh and try again.',
  sign_ins_partial: 'Some sign-ins couldn’t be cleared. Try again.',
  browser_download: 'Couldn’t download the browser. Check your connection and try again.',
  cancelled: 'Browser setup stopped. Open it again to continue.',
  focus_unavailable: 'This tab stopped responding. Choose it again.',
  handoff_open: 'An agent is waiting on you in this browser. Answer its card first.',
  history_refused: 'DorkOS doesn’t open that page here, so you stayed on this one.',
  no_history: 'There’s no page to go to that way.',
  history_changed: 'The page’s history changed. Try again.',
};

/** Browser refusals whose own words are already written for a person, shown as they are. */
const OWN_WORDS: ReadonlySet<string> = new Set([
  'handoff_ended',
  'signing_in',
  'sign_in_failed',
  'no_tab',
  'unsupported',
  'window_unlabelled',
  'profiles_folder_changed',
]);

/** Two refusals whose own sentence is one of a few fixed ones, kept as written when it is. */
const OWN_SENTENCES: Readonly<Record<string, { known: readonly string[]; otherwise: string }>> = {
  busy: {
    known: ['Restart DorkOS to finish closing this browser.'],
    otherwise: 'Browser is busy. Wait a moment.',
  },
  browser_storage: {
    known: [
      'Free some space, then open the browser again.',
      'Check folder permissions, then open the browser again.',
    ],
    otherwise: 'Couldn’t save the browser. Check free space and folder permissions.',
  },
};

/** The browser's own sentence while it closes, which a person reads more plainly. */
const STILL_CLOSING = 'The browser is still closing. Wait before opening it again.';

/** What an answer says for a browser refusal no sentence here covers. */
const BROWSER_FALLBACK = 'Couldn’t reach the browser. Try again.';

/**
 * The sentence a person reads for one browser refusal: a fixed one, never a
 * page's words and never an agent's instructions.
 *
 * @param error - The refusal the browser service threw.
 * @returns The sentence for the problem's `detail`.
 */
export function browserRefusalSentence(error: LocalBrowserError): string {
  const page = PAGE_WORDED_REFUSALS[error.code] ?? PERSON_WORDS[error.code];
  if (page !== undefined) return page;
  if (error.code === 'busy' && error.message === STILL_CLOSING)
    return 'The browser is still closing. Wait, then try again.';
  const own = OWN_SENTENCES[error.code];
  if (own) return own.known.includes(error.message) ? error.message : own.otherwise;
  return OWN_WORDS.has(error.code) && error.message !== '' ? error.message : BROWSER_FALLBACK;
}

/** What a browser viewer that lost its standing is told. */
const VIEWER_DENIED = 'Open the browser view again.';

/** Refuse anything but the owner, in person, at this computer. */
const personOnly: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (requirePersonAtThisComputer(honoRequestFacts(c)) !== undefined)
    return problem(c, 'person_only', { detail: 'Only you can do this, from DorkOS.' });
  return next();
};

/** Mount owner-only human controls under /api/local-browser. */
export function createLocalBrowserRoutes(
  service: LocalBrowserService,
  profiles?: LocalBrowserProfileRouteDeps,
  viewers?: BrowserViewerRegistry
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.use('*', async (c, next) => {
    const facts = honoRequestFacts(c);
    if (!isAtThisComputer(facts))
      return problem(c, 'operator_only', {
        detail: 'Use DorkOS on this computer to control its browser.',
      });
    if (refuseUnlessAccountOwner(facts) !== undefined)
      return problem(c, 'owner_only', { detail: 'Only this DorkOS owner can choose its browser.' });
    return next();
  });
  router.onError((error, c) => {
    // A viewer that lost its standing opens the view again; it is never told why.
    if (error instanceof BrowserViewerError)
      return problem(c, 'forbidden', { detail: VIEWER_DENIED });
    // A browser refusal goes out as the code a reader acts on, with a fixed
    // sentence written for a person: never a page's words (DOR-4979 review).
    if (error instanceof LocalBrowserError)
      return problem(c, BROWSER_PROBLEM_CODES[error.code] ?? 'conflict', {
        detail: browserRefusalSentence(error),
      });
    if (error instanceof z.ZodError)
      return problem(c, 'invalid_request', { detail: 'Check your browser choice and try again.' });
    return problem(c, 'internal_error', { detail: 'Couldn’t use the browser. Try again.' });
  });
  const selector = (c: Context<ApiEnv>) =>
    z.string().min(1).max(256).optional().parse(c.req.query('sessionId')) ?? null;
  const selected = (c: Context<ApiEnv>) => service.personSession(selector(c)).handover;
  router.get('/handoff/state', async (c) => c.json(await service.handover.state()));
  router.get('/capabilities', (c) => c.json(service.capabilities()));
  router.get('/state', async (c) => {
    const id = c.req.header('x-viewer-id'),
      nonce = c.req.header('x-viewer-nonce');
    if (!id && !nonce) return c.json(await service.personState(selector(c)));
    const facts = honoRequestFacts(c);
    const person = browserViewerPrincipal(facts, requirePersonAtThisComputer(facts) === undefined);
    if (
      !viewers ||
      !person ||
      !viewerSecretSchema.safeParse(id).success ||
      !viewerSecretSchema.safeParse(nonce).success ||
      !id ||
      !nonce
    )
      return problem(c, 'forbidden', { detail: VIEWER_DENIED });
    const selected = selector(c);
    const state = await viewers.address(person, id, nonce, selected, () =>
      service.personState(selected)
    );
    const decision = await decideSessionGate('GET', c.req.path, honoRequestFacts(c));
    if (!decision.allowed) throw new BrowserViewerError('viewer_denied');
    const fresh = { ...honoRequestFacts(c), user: decision.user };
    const still =
      decision.allowed &&
      browserViewerPrincipal(fresh, requirePersonAtThisComputer(fresh) === undefined);
    if (!still || still.ownerId !== person.ownerId || still.sessionId !== person.sessionId)
      throw new BrowserViewerError('viewer_denied');
    viewers.assertLive(person, id, nonce);
    return c.json(state);
  });
  // Opening and resuming end a handoff and lift a Stop task, so they take a person too.
  router.post('/open', personOnly, async (c) =>
    c.json(await service.handover.open(LocalBrowserOpenSchema.parse(readJsonBody(c))))
  );
  // These can move or close the page under an open card, so they take a person too.
  router.post('/tabs/:id/select', personOnly, async (c) =>
    c.json(await selected(c).selectTab(c.req.param('id')))
  );
  router.post('/navigate', personOnly, async (c) => {
    const { url, httpFallback } = z
      .object({ url: z.string().url(), httpFallback: z.boolean().optional() })
      .strict()
      .parse(readJsonBody(c));
    return c.json(await selected(c).navigate(url, { httpFallback: httpFallback === true }));
  });
  // Taking the page shuts an agent out of it, so only a person can.
  router.post('/take-over', personOnly, async (c) => c.json(await selected(c).takeOver()));
  // Back and Forward move the page too, and take it from a driving agent (DOR-4449).
  router.post('/history', personOnly, async (c) => {
    const { direction } = z
      .object({ direction: LocalBrowserHistoryDirectionSchema })
      .strict()
      .parse(readJsonBody(c));
    return c.json(await selected(c).stepHistory(direction));
  });
  router.post('/pause', async (c) => c.json(await selected(c).pause()));
  router.post('/resume', personOnly, async (c) => c.json(await selected(c).resume()));
  // Signing in and answering a handoff take a person: no agent, API key or approval token.
  router.post('/sign-in', personOnly, async (c) => {
    const input = LocalBrowserSignInRequestSchema.parse(readJsonBody(c));
    return c.json(
      await ('handoffId' in input ? service.handover.signIn(input) : selected(c).signIn(input))
    );
  });
  // Done signing in answers at once; the state stream reports the saved result.
  router.post('/sign-in/done', personOnly, async (c) => {
    const { handoffId } = LocalBrowserSignInDoneSchema.parse(readJsonBody(c));
    await (handoffId
      ? service.handover.finishSignIn(handoffId)
      : selected(c).finishSignIn(undefined));
    return c.json({ accepted: true }, 202);
  });
  router.post('/handoff/hand-back', personOnly, async (c) => {
    const { handoffId } = LocalBrowserHandoffAnswerSchema.parse(readJsonBody(c));
    return c.json(await service.handover.handBack(handoffId));
  });
  router.post('/handoff/stop', personOnly, async (c) => {
    const { handoffId } = LocalBrowserHandoffAnswerSchema.parse(readJsonBody(c));
    return c.json(await service.handover.stop(handoffId));
  });
  router.post('/disconnect', personOnly, async (c) => c.json(await selected(c).disconnect()));
  if (profiles) mountLocalBrowserProfileRoutes(router, profiles);
  mountLocalBrowserProfileRemoval(router, service, profiles);
  return router;
}
