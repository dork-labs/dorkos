/**
 * `/api/hub/computers`: the hub's owner chatting with the agents on their own
 * linked computers (spec `everything-is-a-space` step B1, DOR-2944), over each
 * computer's session relay connection (`services/core/hub-relay/`).
 *
 * Only a serving hub answers; on a person's own computer every path here is
 * the `/api` 404. The chain's session gate already asks every hub request for
 * a credential (`services/core/auth/gate-policy.ts`). On top of that, **only
 * the person's own browser sign-in reaches these routes, reads included;
 * agents and API keys never do.** They reach a person's own chats on their own
 * computer, so a caller presenting agent identity (`X-DorkOS-Agent`) is
 * refused, and so is any credential but the session cookie: a per-user API
 * key is what an MCP client or an agent may hold. The stream also answers only
 * a request that accepts `text/event-stream`, so a plain GET cannot read it
 * past the hub's own-page check.
 *
 * **Only the protocol goes over the relay.** Each request is built from its
 * path and body into one of the shared relay request shapes
 * (`@dorkos/shared/session-relay`) and parsed by that schema before it is
 * sent, so a field the protocol does not carry (a folder, a runtime, a
 * permission mode) is a 400, never something forwarded. Approvals are not
 * offered: a computer refuses them until they can carry a passkey proof.
 *
 * **Which browser asked.** Each relayed request names the owner's browser
 * (`device`): an id from a cookie of its own, set here the first time the
 * browser comes without one, and a label read from its `User-Agent`
 * (`services/core/hub-relay/browser-device.ts`). Never the sign-in token.
 * The computer remembers it and tells its owner about a new one; a request
 * from a browser without the cookie yet names none.
 *
 * A linked computer that is not connected right now is woken
 * (`computer-waker.ts`) and answered with 503 and `Retry-After`. What the
 * computer refuses is answered with its own status and sentence, except a
 * 401: that is the computer turning the hub away, never the person being
 * signed out here, so it is answered 502.
 *
 * The owner's link routes (minting a link code, unlinking a computer) live in
 * `hub-computer-links.ts` and sit behind the same guard.
 *
 * @module routes/hub-computers
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  RelayRequestSchema,
  missingRelayFeature,
  type RelayDevice,
  type RelayError,
  type RelayRequest,
} from '@dorkos/shared/session-relay';
import type { AuditOutcome } from '@dorkos/shared/audit-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { errorBody } from '../lib/route-utils.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { currentServerRole } from '../lib/server-role.js';
import { currentAuditActor } from '../services/audit/audit-context.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import { AUTH_COOKIES_SECURE } from '../services/core/auth/cookie-security.js';
import {
  browserDevice,
  browserDeviceSetCookie,
  computerConnection,
  hubComputerWaker,
  hubViewers,
  describeUserAgent,
  mintBrowserDeviceId,
  readLinkedComputers,
  type HubComputerConnection,
  type RelayCallRequest,
} from '../services/core/hub-relay/index.js';
import { relayedStream } from './hub-computer-stream.js';
import {
  liveHubComputerLinkDeps,
  mountHubComputerLinkRoutes,
  type HubComputerLinkDeps,
} from './hub-computer-links.js';

/** The part of a computer's connection these routes use. */
export type RelayedComputer = Pick<
  HubComputerConnection,
  'connected' | 'features' | 'request' | 'openStream'
>;

/** What the routes read, injectable for tests. */
export interface HubComputerRoutesDeps {
  /** Whether this server is a hub. */
  isHub: () => boolean;
  /** The ids of the computers this hub serves. */
  linkedComputerIds: () => readonly string[];
  /** A computer's live connection, or `null` when it is not connected. */
  connection: (computerId: string) => RelayedComputer | null;
  /** Ask for a computer to dial in. Debounced, never throws. */
  wake: (computerId: string) => void;
  /** Counts open chat streams per computer. */
  viewers: { open: (computerId: string) => () => void };
  /** Whether cookies are `Secure`, which names the browser's device cookie; `false` when absent. */
  secureCookies?: boolean;
}

const liveDeps: HubComputerRoutesDeps = {
  isHub: () => currentServerRole() === 'hub',
  linkedComputerIds: () => readLinkedComputers().map((computer) => computer.computerId),
  connection: computerConnection,
  wake: (computerId) => {
    hubComputerWaker.wake(computerId);
  },
  viewers: hubViewers,
  secureCookies: AUTH_COOKIES_SECURE,
};

/** How long a page should wait before asking again while a computer wakes. */
export const HUB_COMPUTER_RETRY_AFTER_SECONDS = 5;

/** The wording for a feature a computer did not advertise. */
const NEEDS_UPDATE_MESSAGE = 'This computer needs an update for that.';

/**
 * A computer's 401 refuses the hub, not the person: passed through, it would
 * read as the owner being signed out here.
 */
const COMPUTER_TURNED_AWAY: RelayError = {
  status: 502,
  code: 'computer_refused',
  message: 'Your computer turned this request away.',
};

/** The `/api` 404, which a computer this hub does not serve answers too. */
const NOT_FOUND = errorBody('Not found', 'API_NOT_FOUND');

/** Answer a refusal in the relay's own words. */
function relayFailure(c: Context<ApiEnv>, error: RelayError): Response {
  return c.json(
    {
      error: error.message,
      code: error.code,
      message: error.message,
      ...(error.feature ? { feature: error.feature } : {}),
    },
    error.status as ContentfulStatusCode
  );
}

/** A 400 for a request that is not one of the protocol's shapes. */
function invalid(c: Context<ApiEnv>): Response {
  return relayFailure(c, { status: 400, code: 'invalid', message: 'That request is not valid.' });
}

/** Parse a request built from the path and body, or `null` when it is not one. */
function relayRequest<Op extends RelayRequest['op']>(
  op: Op,
  fields: Record<string, unknown>
): Extract<RelayRequest, { op: Op }> | null {
  const parsed = RelayRequestSchema.safeParse({ ...fields, op });
  return parsed.success ? (parsed.data as Extract<RelayRequest, { op: Op }>) : null;
}

/**
 * The body as an object to build a request from, or `null` when it is not one
 * or names a field the path decides (`op`, `sessionId`, `kind`), so a body can
 * never quietly point a request somewhere its path does not.
 */
function bodyObject(c: Context<ApiEnv>): Record<string, unknown> | null {
  const body = readJsonBody(c, { emptyAs: {} });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return ['op', 'sessionId', 'kind'].some((key) => Object.hasOwn(body, key))
    ? null
    : (body as Record<string, unknown>);
}

/**
 * Record a change the owner made on a linked computer's chat. Names the chat
 * and the computer, never what was said, and is readable by the actor alone.
 */
function auditRelayed(
  entry: { action: string; summary: string; sessionId: string; computerId: string },
  outcome: AuditOutcome,
  error?: RelayError
): void {
  const scope = currentAuditActor();
  recordAudit({
    action: entry.action,
    operation: 'execute',
    outcome,
    target: { type: 'session', id: entry.sessionId, containerId: entry.computerId },
    summary: entry.summary,
    ...(error ? { error: error.code } : {}),
    ...(scope ? { visibility: 'participants', participants: [scope.actor.accountId] } : {}),
  });
}

/**
 * The `/api/hub/computers` routes, with the owner's link routes
 * (`hub-computer-links.ts`) behind the same guard.
 *
 * @param deps - Override for tests; defaults to the live store, registry and waker.
 * @param links - Override for tests; defaults to the live codes and store.
 */
export function createHubComputerRoutes(
  deps: HubComputerRoutesDeps = liveDeps,
  links: HubComputerLinkDeps = liveHubComputerLinkDeps
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    if (!deps.isHub()) return c.json(NOT_FOUND, 404);
    if (presentsAgentIdentity(honoRequestFacts(c))) {
      return c.json(errorBody("Agents can't reach your computers.", 'FORBIDDEN'), 403);
    }
    // The gate already asked for a credential; this holds even if it ever did not.
    const user = c.get('user');
    if (!user) return c.json(errorBody('Sign in to reach your computers.', 'UNAUTHORIZED'), 401);
    if (user.credential !== 'cookie') {
      return c.json(
        errorBody('Manage your computers from your own signed-in browser.', 'FORBIDDEN'),
        403
      );
    }
    // A browser without its device cookie gets one with this answer, and this
    // very request already names it: a client that never keeps cookies (curl
    // with a stolen sign-in) is a new device every time, so the computer's
    // new-device notice still fires, under its hourly cap. The stream route
    // writes its own head, so it is handed the same cookie.
    if (!deviceOf(c)) {
      const id = mintBrowserDeviceId();
      const cookie = browserDeviceSetCookie(id, deps.secureCookies === true);
      c.header('Set-Cookie', cookie, { append: true });
      mintedCookies.set(c.env.incoming, cookie);
      mintedDevices.set(c.env.incoming, {
        id,
        label: describeUserAgent(c.req.header('user-agent')),
      });
    }
    await next();
  });

  /** The device cookie minted for a request, by its Node request, for the stream's own head. */
  const mintedCookies = new WeakMap<object, string>();
  /** The device minted for a request that came without its cookie, by its Node request. */
  const mintedDevices = new WeakMap<object, RelayDevice>();

  /** The browser that asked: from its device cookie, or the one just minted for it. */
  function deviceOf(c: Context<ApiEnv>): RelayDevice | undefined {
    const headers = { cookie: c.req.header('cookie'), userAgent: c.req.header('user-agent') };
    return (
      browserDevice(headers, deps.secureCookies === true) ??
      mintedDevices.get(c.env.incoming) ??
      undefined
    );
  }

  /** The computer's live connection, or the answer to give instead. */
  function reach(c: Context<ApiEnv>, computerId: string): RelayedComputer | Response {
    if (!deps.linkedComputerIds().includes(computerId)) {
      return c.json(NOT_FOUND, 404);
    }
    const computer = deps.connection(computerId);
    if (computer?.connected) return computer;
    deps.wake(computerId);
    c.header('Retry-After', String(HUB_COMPUTER_RETRY_AFTER_SECONDS));
    const message = 'Waking your computer. Try again in a moment.';
    return c.json({ error: message, code: 'computer_waking', message }, 503);
  }

  /** The 501 for a feature the computer did not advertise, or `null`. */
  function unsupported(
    c: Context<ApiEnv>,
    computer: RelayedComputer,
    request: RelayRequest
  ): Response | null {
    const feature = missingRelayFeature(computer.features, request);
    return feature
      ? relayFailure(c, {
          status: 501,
          code: 'needs_update',
          feature,
          message: NEEDS_UPDATE_MESSAGE,
        })
      : null;
  }

  /** Send one request and answer with its body, recording it when `audit` says so. */
  async function call(
    c: Context<ApiEnv>,
    computerId: string,
    request: RelayCallRequest | null,
    audit?: { action: string; summary: string; sessionId: string }
  ): Promise<Response> {
    if (!request) return invalid(c);
    const computer = reach(c, computerId);
    if (computer instanceof Response) return computer;
    const refused = unsupported(c, computer, request);
    if (refused) return refused;
    const result = await computer.request(request, deviceOf(c));
    if (audit) {
      const outcome: AuditOutcome = result.ok
        ? 'ok'
        : result.error.status < 500
          ? 'refused'
          : 'failed';
      auditRelayed({ ...audit, computerId }, outcome, result.ok ? undefined : result.error);
    }
    if (result.ok) return c.json(result.body);
    return relayFailure(c, result.error.status === 401 ? COMPUTER_TURNED_AWAY : result.error);
  }

  mountHubComputerLinkRoutes(router, links);

  router.get('/', (c) =>
    c.json({
      computers: deps.linkedComputerIds().map((computerId) => {
        const connection = deps.connection(computerId);
        const connected = connection?.connected === true;
        const record = links.record(computerId);
        return {
          computerId,
          computerName: record?.computerName ?? null,
          linkedAt: record?.linkedAt ?? null,
          connected,
          features: connected ? [...connection!.features] : [],
        };
      }),
    })
  );

  router.get('/:computerId/agents/:agentId/chats', (c) =>
    call(
      c,
      c.req.param('computerId'),
      relayRequest('chats.list', { agentId: c.req.param('agentId') })
    )
  );

  router.get('/:computerId/sessions/:sessionId/stream', (c) => {
    if (!(c.req.header('accept') ?? '').includes('text/event-stream')) {
      return c.json(errorBody('This address is an event stream.', 'NOT_ACCEPTABLE'), 406);
    }
    const computerId = c.req.param('computerId');
    const resume = c.req.header('last-event-id') ?? c.req.query('resume');
    // The stream id is the connection's to choose; this one only checks the shape.
    const request = relayRequest('session.stream', {
      streamId: 's0',
      sessionId: c.req.param('sessionId'),
      ...(resume !== undefined && resume !== '' ? { resume } : {}),
    });
    if (!request) return invalid(c);
    const computer = reach(c, computerId);
    if (computer instanceof Response) return computer;
    const refused = unsupported(c, computer, request);
    if (refused) return refused;
    return relayedStream(c, {
      computer,
      sessionId: request.sessionId,
      resume: request.resume,
      openViewer: () => deps.viewers.open(computerId),
      device: deviceOf(c),
      setCookie: mintedCookies.get(c.env.incoming),
    });
  });

  router.post('/:computerId/sessions/:sessionId/messages', (c) => {
    const sessionId = c.req.param('sessionId');
    const body = bodyObject(c);
    return call(
      c,
      c.req.param('computerId'),
      body ? relayRequest('session.send', { ...body, sessionId }) : null,
      {
        action: 'hub.relay.session.send',
        summary: 'Sent a message to a chat on a linked computer',
        sessionId,
      }
    );
  });

  router.post('/:computerId/sessions/:sessionId/interrupt', (c) => {
    const sessionId = c.req.param('sessionId');
    return call(c, c.req.param('computerId'), relayRequest('session.interrupt', { sessionId }), {
      action: 'hub.relay.session.interrupt',
      summary: 'Stopped a chat on a linked computer',
      sessionId,
    });
  });

  router.post('/:computerId/sessions/:sessionId/answers', (c) => {
    const sessionId = c.req.param('sessionId');
    const body = bodyObject(c);
    return call(
      c,
      c.req.param('computerId'),
      body
        ? relayRequest('interaction.respond', { sessionId, answer: { ...body, kind: 'answer' } })
        : null,
      {
        action: 'hub.relay.interaction.answer',
        summary: 'Answered a question in a chat on a linked computer',
        sessionId,
      }
    );
  });

  return router;
}
