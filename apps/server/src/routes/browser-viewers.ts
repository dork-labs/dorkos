/**
 * Owner-only, this-computer-only app-view protocol, deliberately absent from the developer OpenAPI catalog:
 * API keys/programs cannot use it. Person inputs use six finite guarded verbs.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import { parseViewerJson } from './browser-viewer-body.js';
export { browserViewerBodyRule } from './browser-viewer-body.js';
import { mountViewerControls } from './browser-viewer-controls.js';
import { viewerPaintSchema } from '@dorkos/shared/browser-viewer-control';
import { LocalBrowserError } from '../services/session/local-browser/errors.js';
import { requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { decideSessionGate } from '../services/core/auth/session-gate.js';
import { browserViewerPrincipal } from '../services/session/browser-viewers/viewer-person.js';
import { BrowserViewerError } from '../services/session/browser-viewers/viewer-contract.js';
import type { BrowserViewerRegistry } from '../services/session/browser-viewers/viewer-registry.js';
import { boundViewerResponse } from '../services/session/browser-viewers/response-deadline.js';

const nonceSchema = z.string().regex(/^[\w-]{43}$/);
const frameSchema = z
  .object({
    nonce: nonceSchema,
    receipt: nonceSchema.optional(),
    paint: viewerPaintSchema.optional(),
  })
  .strict();
const closeSchema = z.object({ nonce: nonceSchema }).strict();
/** The problem code for each refusal the viewer services throw. */
const VIEWER_PROBLEM: Record<BrowserViewerError['code'], ProblemCode> = {
  // The view stopped or changed: the app reconnects.
  viewer_unavailable: 'temporarily_unavailable',
  viewer_denied: 'owner_only',
  viewer_busy: 'conflict',
  viewer_limit: 'rate_limited',
  viewer_stale: 'precondition_failed',
  viewer_uncertain: 'conflict',
  file_picker_stuck: 'conflict',
};

/** Mount subscriptions and finite person controls behind the existing app-session and local-owner bars. */
export function createBrowserViewerRoutes(
  registry: BrowserViewerRegistry,
  enabled: () => boolean,
  inputEnabled: () => boolean = () => false
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store, private');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (!enabled()) {
      registry.disableInput();
      return problem(c, 'temporarily_unavailable', { detail: 'Browser viewing is off.' });
    }
    const facts = honoRequestFacts(c);
    // Remote viewing is a separate reviewed stage. Do not widen /api/local-browser.
    if (!isAtThisComputer(facts))
      return problem(c, 'operator_only', { detail: 'Watch from DorkOS on this computer.' });
    if (
      !facts.user?.sessionId ||
      !browserViewerPrincipal(facts, requirePersonAtThisComputer(facts) === undefined)
    )
      return problem(c, 'person_only', {
        detail: 'Turn on sign-in to watch the agent’s browser.',
      });
    if (/\/(take-over|input|hand-back|copy|paste|files)$/.test(c.req.path) && !inputEnabled()) {
      registry.disableInput();
      return problem(c, 'temporarily_unavailable', { detail: 'Browser controls are off.' });
    }
    return next();
  });
  router.use('*', parseViewerJson);
  router.onError((error, c) => {
    if (error instanceof z.ZodError)
      return problem(c, 'invalid_request', { detail: 'Reopen the browser view and try again.' });
    if (
      (error instanceof LocalBrowserError || error instanceof BrowserViewerError) &&
      error.code === 'file_picker_stuck'
    )
      return problem(c, 'conflict', {
        detail: 'The file picker got stuck. Close this page in Chrome to hand back.',
      });
    const code = error instanceof BrowserViewerError ? error.code : 'viewer_unavailable';
    return problem(c, VIEWER_PROBLEM[code], {
      detail: 'The browser view changed. Open it again.',
    });
  });
  const principal = (c: Parameters<typeof honoRequestFacts>[0]) => {
    const facts = honoRequestFacts(c);
    if (!facts.user?.sessionId) throw new BrowserViewerError('viewer_denied');
    const person = browserViewerPrincipal(facts, requirePersonAtThisComputer(facts) === undefined);
    if (!person) throw new BrowserViewerError('viewer_denied');
    return person;
  };
  // A long-poll must not finish with the session snapshot from before it waited.
  const stillPerson = async (c: Parameters<typeof honoRequestFacts>[0]) => {
    const facts = honoRequestFacts(c);
    const decision = await decideSessionGate('POST', c.req.path, facts);
    if (!decision.allowed) throw new BrowserViewerError('viewer_denied');
    const fresh = { ...facts, user: decision.user };
    const person = browserViewerPrincipal(fresh, requirePersonAtThisComputer(fresh) === undefined);
    const previous = principal(c);
    if (!person || person.ownerId !== previous.ownerId || person.sessionId !== previous.sessionId)
      throw new BrowserViewerError('viewer_denied');
  };

  router.post('/', async (c) => {
    const { chatId } = z
      .object({ chatId: z.string().min(1).max(128) })
      .strict()
      .parse(readJsonBody(c));
    const person = principal(c);
    const viewer = await registry.subscribe(person, chatId);
    try {
      await stillPerson(c);
      registry.assertLive(person, viewer.viewerId, viewer.nonce);
    } catch (error) {
      await registry.unsubscribe(person, viewer.viewerId, viewer.nonce);
      throw error;
    }
    return c.json(viewer, 201);
  });
  router.post('/:viewerId/frame', async (c) => {
    const { nonce, receipt, paint } = frameSchema.parse(readJsonBody(c));
    let frame = await registry.frame(
      principal(c),
      c.req.param('viewerId'),
      nonce,
      receipt,
      c.req.raw.signal,
      paint
    );
    await stillPerson(c);
    registry.assertLive(principal(c), c.req.param('viewerId'), nonce);
    if (frame && !registry.deliveryCurrent(principal(c), c.req.param('viewerId'), nonce, frame))
      frame = null;
    const view = registry.metadata(principal(c), c.req.param('viewerId'), nonce);
    if (!frame) return c.body(null, 204, { 'X-Viewer-Metadata': JSON.stringify(view) });
    boundViewerResponse(c.env.outgoing);
    return c.body(new Uint8Array(frame.bytes), 200, {
      'Content-Type': 'image/jpeg',
      'X-Frame-Receipt': frame.receipt,
      'X-Frame-Metadata': JSON.stringify({
        sequence: frame.sequence,
        generation: frame.generation,
        width: frame.width,
        height: frame.height,
        byteLength: frame.bytes.length,
        view,
      }),
    });
  });
  router.delete('/:viewerId', async (c) => {
    const { nonce } = closeSchema.parse(readJsonBody(c));
    await registry.unsubscribe(principal(c), c.req.param('viewerId'), nonce);
    return c.body(null, 204);
  });
  mountViewerControls(router, registry, inputEnabled, principal, stillPerson);
  return router;
}
