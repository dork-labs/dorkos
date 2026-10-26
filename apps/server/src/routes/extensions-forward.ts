/**
 * `api.forward` on the server (DOR-3325): a mini app's page forwards what the
 * person typed to the agent they picked for it, as their own words, under
 * `/api/extensions/:id/forward`.
 *
 * | Route                                 | What                          | Bar         |
 * | ------------------------------------- | ----------------------------- | ----------- |
 * | `POST /:id/forward`                   | forward the typed text        | forward bar |
 * | `GET  /:id/forward/:forwardId/replies`| the agent's answers           | read bar    |
 * | `GET  /:id/forward/stamps?ids=a,b`    | who wrote each forward, as DorkOS recorded it | read bar |
 * | `POST /:id/forward/pending/:pendingId/allow`   | allow the agent, send the kept text | forward bar; Wi-Fi refuses |
 * | `POST /:id/forward/pending/:pendingId/decline` | drop the kept text            | forward bar |
 * | `GET  /:id/forward-agents`            | the agents the person allowed | read bar    |
 * | `PUT  /:id/forward-agents`            | change them                   | person bar + forward bar; Wi-Fi refuses (`wifi-level.ts`) |
 *
 * **DorkOS reads the forward's body itself.** The page POSTs here directly;
 * no extension server code runs between the person's request and the post in
 * their Direct chat, so DorkOS can tell what they typed from what code made
 * up. The body may name an agent, but it reaches only one on the person's
 * list (`extensions.forwardAgents`).
 *
 * **The first time,** a forward naming a registered agent that is not on the
 * list answers 409 `no_agent` with a `consent` block: DorkOS kept the typed
 * text, and the app's host (core client code, never the extension) draws
 * "Send {app} comments to {agent}?" with the agent's REGISTERED name. Allow
 * POSTs the `allow` route with an empty body: DorkOS adds that one id and
 * sends the text it kept. Nothing the extension sends after the first POST
 * reaches the message.
 *
 * **The forward bar** is the room-write bar (`extensions-rooms-bar.ts`: no
 * relay, no agent, a trusted `Origin` required, the app window's
 * `X-Client-Id`, a browser session) plus three more: the gate must have
 * verified a signed-in browser session (login on, and asking on this computer
 * too when the request is from it), the caller must be the install's owner,
 * and the body must be JSON. A request the gate left open proves only "this
 * computer", not "this person", and these words are trusted as the person's,
 * so it refuses.
 *
 * Every forward, and every refused one, writes one audit row with the mini
 * app named.
 *
 * @module routes/extensions-forward
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { FORWARD_ITEM_ID_PATTERN } from '@dorkos/shared/chat-messages';
import {
  FORWARD_ITEM_ID_MAX_CHARS,
  FORWARD_ITEM_TITLE_MAX_CHARS,
  FORWARD_STAMPS_MAX,
  FORWARD_TEXT_MAX_CHARS,
  type ExtensionStatus,
  type ForwardErrorCode,
  type ForwardReceipt,
} from '@dorkos/extension-api';
import { getRoomService, type AuthorRecord } from '../services/rooms/index.js';
import { getDirectChats } from '../services/rooms/direct-chat/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import {
  PersonForwardError,
  PersonForwards,
  FORWARD_AGENTS_MAX,
  setForwardAgents,
  type ForwardRequest,
  type PersonForwardDeps,
} from '../services/extensions/forward/person-forward.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { wifiTurnBound } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { logger } from '../lib/logger.js';
import { resolveCaller } from './room-caller.js';
import { isOwnerCaller } from './room-error-response.js';
import { refuseRoomWrite, type RoomWriteRefusal } from './extensions-rooms-bar.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** The statuses of a mini app that is turned on. */
const TURNED_ON: ReadonlySet<ExtensionStatus> = new Set(['enabled', 'compiled', 'active']);

/** The HTTP status for each refusal. */
const STATUS_FOR: Record<ForwardErrorCode, ContentfulStatusCode> = {
  no_agent: 409,
  not_found: 404,
  person_required: 403,
  extension_off: 409,
  invalid_input: 400,
  unavailable: 503,
};

/** Why the forward bar refused, beyond the room-write bar's reasons. */
export type ForwardRefusal = RoomWriteRefusal | 'login-off' | 'not-the-owner' | 'not-json';

/** What the person is told for each refusal. */
const REFUSAL_MESSAGE: Record<ForwardRefusal, string> = {
  relayed: 'Nothing was sent. A mini app can only forward from your own window of DorkOS.',
  agent: 'Nothing was sent. Only the person can forward a comment, not an agent.',
  'no-origin': 'Nothing was sent. A mini app can only forward from your own window of DorkOS.',
  'other-site': 'Nothing was sent. This request came from a page that is not DorkOS.',
  'no-app-window': 'Nothing was sent. A mini app can only forward from your own window of DorkOS.',
  'not-a-browser-session':
    'Nothing was sent. Sign in to DorkOS in your browser to forward from a mini app.',
  'login-off':
    'Nothing was sent. DorkOS must ask for your password here, so it can tell your words are yours.',
  'not-the-owner': 'Nothing was sent. Only the person who owns DorkOS can forward to their agents.',
  'not-json': 'Nothing was sent. Send the comment as JSON.',
};

/** What a mini app that never asked to forward is told. */
const NO_FORWARD_DECLARED =
  'This mini app does not ask to forward comments. Add "capabilities": { "forward": true } to its manifest.';

const ForwardBodySchema = z
  .object({
    text: z
      .string()
      .max(FORWARD_TEXT_MAX_CHARS)
      .refine((t) => t.trim().length > 0),
    itemId: z.string().min(1).max(FORWARD_ITEM_ID_MAX_CHARS).regex(FORWARD_ITEM_ID_PATTERN),
    itemTitle: z.string().max(FORWARD_ITEM_TITLE_MAX_CHARS).optional(),
    agentId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const ForwardAgentsBodySchema = z
  .object({ agentIds: z.array(z.string().min(1).max(200)).max(FORWARD_AGENTS_MAX) })
  .strict();

/** The Allow and decline take no body: everything comes from what DorkOS kept. */
const EmptyBodySchema = z.object({}).strict();

/** What the person bar says when it refuses a change of agent. */
const FORWARD_AGENTS_BAR: PersonBarCopy = {
  error: 'Only a person can choose the agents a mini app forwards to.',
  code: 'forward_agents_person_required',
  subject: 'which agents a mini app forwards to',
  crossSite: (origin) =>
    `Nothing changed. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can choose the agents a mini app forwards to.`,
  agent: 'Nothing changed. Only a person can choose the agents a mini app forwards to.',
};

/** Whether a mini app's manifest asks to forward (`capabilities.forward`). */
function asksToForward(record: { manifest: { capabilities?: { forward?: boolean } } }): boolean {
  return record.manifest.capabilities?.forward === true;
}

/**
 * Run the forward bar.
 *
 * @param facts - The request's facts.
 * @param contentType - The request's `Content-Type`.
 * @returns `undefined` when the signed-in owner is asking from their own window.
 */
export function refuseForward(
  facts: RequestFacts,
  contentType: string | undefined
): ForwardRefusal | undefined {
  const roomWrite = refuseRoomWrite(facts);
  if (roomWrite) return roomWrite;
  // The room-write bar passes a request the gate left open (login off, or a
  // computer that does not ask for a password) with no credential at all.
  // Here that is not enough: the gate only verifies a session it asked for, so
  // an open request proves "this computer", never "this person".
  if (facts.user?.credential !== 'cookie') return 'login-off';
  if (!/^application\/json\s*(?:;|$)/iu.test(contentType ?? '')) return 'not-json';
  return undefined;
}

/**
 * The bar for reading a forward's replies: the agent's answers to the person
 * are theirs, so nothing relayed, no agent, no other site, the app window's
 * `X-Client-Id`, and a gate-verified browser session. A browser sends no
 * `Origin` on a same-origin GET, so `Sec-Fetch-Site` stands in for it.
 *
 * @param facts - The request's facts.
 * @returns `undefined` when the signed-in owner is reading from their own window.
 */
export function refuseForwardRead(facts: RequestFacts): ForwardRefusal | undefined {
  if (facts.ingress === 'relay') return 'relayed';
  if (presentsAgentIdentity(facts)) return 'agent';
  if (facts.headers[APPROVAL_TOKEN_HEADER] !== undefined) return 'agent';
  const site = facts.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'other-site';
  const clientId = facts.headers['x-client-id'];
  if (typeof clientId !== 'string' || clientId.length === 0) return 'no-app-window';
  if (facts.user?.credential !== 'cookie') return 'login-off';
  return undefined;
}

/**
 * The forward service's dependencies, read live: rooms and Direct chats start
 * after the routes mount, and until then a forward is "unavailable".
 *
 * @param mesh - Mesh, when it is running.
 */
export function liveForwardDeps(
  mesh: PersonForwardDeps['mesh'] = () => undefined
): PersonForwardDeps {
  return {
    rooms: () => {
      try {
        return getRoomService();
      } catch {
        return undefined;
      }
    },
    directChats: () => getDirectChats() ?? undefined,
    mesh,
  };
}

/** A refusal, answered. */
function refuse(c: Context<ApiEnv>, code: ForwardErrorCode, message: string): Response {
  return c.json({ error: message, code }, STATUS_FOR[code]);
}

/**
 * Mount the `api.forward` routes and the forward-agents setting on the
 * extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - For the mini app's name and whether it is on.
 * @param safeExtId - The id pattern the parent router validates against.
 * @param deps - Rooms, Direct chats and Mesh, read at call time.
 */
export function registerExtensionForwardRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  safeExtId: RegExp,
  deps: PersonForwardDeps
): void {
  const forwards = new PersonForwards(deps);

  /** The mini app, turned on and asking to forward, or the refusal. */
  const appFor = (
    c: Context<ApiEnv>
  ): { extensionId: string; extensionName: string } | Response => {
    const extensionId = c.req.param('id') ?? '';
    if (!safeExtId.test(extensionId)) return c.json({ error: 'Invalid extension ID' }, 400);
    const record = extensionManager.get(extensionId);
    if (!record) return refuse(c, 'not_found', `No mini app named ${extensionId}.`);
    if (!TURNED_ON.has(record.status)) {
      return refuse(
        c,
        'extension_off',
        `Turn on ${record.manifest.name} in Settings → Extensions first.`
      );
    }
    if (!asksToForward(record)) return refuse(c, 'invalid_input', NO_FORWARD_DECLARED);
    return { extensionId, extensionName: record.manifest.name };
  };

  /** The install's owner, as a room author, or undefined. */
  const ownerOf = (c: Context<ApiEnv>): AuthorRecord | undefined => {
    try {
      const viewer = resolveCaller(honoRequestFacts(c));
      return viewer.kind === 'human' && isOwnerCaller(viewer) ? viewer : undefined;
    } catch {
      return undefined;
    }
  };

  /** Run one call, answering a {@link PersonForwardError} as its refusal. */
  const answer = (c: Context<ApiEnv>, run: () => Response): Response => {
    try {
      return run();
    } catch (err) {
      if (err instanceof PersonForwardError) return refuse(c, err.code, err.message);
      logger.error('[Extensions] A mini app forward call failed', err);
      return refuse(c, 'unavailable', 'DorkOS could not do that. Try again.');
    }
  };

  /**
   * The forward bar, the mini app and the owner, in that order, each refusal
   * audited; or what the call may act for.
   */
  const gate = (
    c: Context<ApiEnv>
  ): { app: { extensionId: string; extensionName: string }; viewer: AuthorRecord } | Response => {
    // The bar runs first, so a refused attempt is recorded whoever made it.
    const auditRefused = (why: string) => {
      const extensionId = c.req.param('id') ?? '';
      const record = safeExtId.test(extensionId) ? extensionManager.get(extensionId) : undefined;
      if (record)
        auditForward({ extensionId, extensionName: record.manifest.name }, 'refused', why);
    };
    const refusal = refuseForward(honoRequestFacts(c), c.req.header('content-type'));
    if (refusal) {
      auditRefused(refusal);
      return refuse(c, 'person_required', REFUSAL_MESSAGE[refusal]);
    }
    const app = appFor(c);
    if (app instanceof Response) {
      auditRefused('app');
      return app;
    }
    const viewer = ownerOf(c);
    if (!viewer) {
      auditRefused('not-the-owner');
      return refuse(c, 'person_required', REFUSAL_MESSAGE['not-the-owner']);
    }
    return { app, viewer };
  };

  /** Send, audit and answer; a refusal is audited and answered too. */
  const send = (
    c: Context<ApiEnv>,
    app: { extensionId: string; extensionName: string },
    itemId: string | (() => string),
    run: () => ForwardReceipt,
    onNoAgent?: (err: PersonForwardError) => Response | undefined
  ): Response => {
    try {
      const receipt = run();
      auditForward(app, 'ok', undefined, {
        forwardId: receipt.id,
        agentId: receipt.agent.id,
        itemId: typeof itemId === 'string' ? itemId : itemId(),
      });
      return c.json(receipt, 201);
    } catch (err) {
      if (err instanceof PersonForwardError) {
        auditForward(app, 'refused', err.code);
        return onNoAgent?.(err) ?? refuse(c, err.code, err.message);
      }
      logger.error('[Extensions] A mini app forward failed', err);
      auditForward(app, 'failed');
      return refuse(c, 'unavailable', 'The comment was not sent. Try again.');
    }
  };

  router.post('/:id/forward', (c) => {
    const caller = gate(c);
    if (caller instanceof Response) return caller;
    const { app, viewer } = caller;
    const body = ForwardBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) {
      auditForward(app, 'refused', 'invalid_input');
      return refuse(
        c,
        'invalid_input',
        `Send { text, itemId } and an optional itemTitle and agentId. Text is 1 to ${FORWARD_TEXT_MAX_CHARS.toLocaleString('en-US')} characters.`
      );
    }
    const bound = wifiTurnBound(honoRequestFacts(c));
    const request: ForwardRequest = {
      extensionId: app.extensionId,
      appName: app.extensionName,
      viewer,
      text: body.data.text,
      itemId: body.data.itemId,
      ...(body.data.itemTitle !== undefined ? { itemTitle: body.data.itemTitle } : {}),
      ...(body.data.agentId !== undefined ? { agentId: body.data.agentId } : {}),
      ...(bound !== undefined ? { bound } : {}),
      clientId: c.req.header('x-client-id') ?? '',
    };
    return send(
      c,
      app,
      body.data.itemId,
      () => forwards.forward(request),
      (err) => {
        if (err.code !== 'no_agent' || err.suggestedAgentId === undefined) return undefined;
        // Kept here, so the Allow sends exactly these words and nothing the
        // extension says afterwards.
        const consent = forwards.hold(request, err.suggestedAgentId);
        return c.json({ error: err.message, code: err.code, consent }, STATUS_FOR.no_agent);
      }
    );
  });

  router.post('/:id/forward/pending/:pendingId/allow', (c) => {
    const caller = gate(c);
    if (caller instanceof Response) return caller;
    if (!EmptyBodySchema.safeParse(readJsonBody(c, { emptyAs: {} })).success) {
      return refuse(c, 'invalid_input', 'Allow takes no body. DorkOS sends the comment it kept.');
    }
    const { app, viewer } = caller;
    let itemId = '';
    return send(
      c,
      app,
      () => itemId,
      () => {
        const sent = forwards.allow(
          app.extensionId,
          viewer,
          c.req.param('pendingId'),
          c.req.header('x-client-id') ?? ''
        );
        itemId = sent.itemId;
        const { itemId: _item, ...receipt } = sent;
        return receipt;
      }
    );
  });

  router.post('/:id/forward/pending/:pendingId/decline', (c) => {
    const caller = gate(c);
    if (caller instanceof Response) return caller;
    forwards.decline(
      caller.app.extensionId,
      caller.viewer,
      c.req.param('pendingId'),
      c.req.header('x-client-id') ?? ''
    );
    return c.body(null, 204);
  });

  // Read-only: the stamps are DorkOS's own record of each forward's author,
  // so a mini app can tell its real forwards from comments its data claims.
  router.get('/:id/forward/stamps', (c) => {
    const refusal = refuseForwardRead(honoRequestFacts(c));
    if (refusal) return refuse(c, 'person_required', REFUSAL_MESSAGE[refusal]);
    const app = appFor(c);
    if (app instanceof Response) return app;
    const viewer = ownerOf(c);
    if (!viewer) return refuse(c, 'person_required', REFUSAL_MESSAGE['not-the-owner']);
    const raw = readQuery(c).ids;
    const ids = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length > FORWARD_STAMPS_MAX) {
      return refuse(
        c,
        'invalid_input',
        `Ask about at most ${FORWARD_STAMPS_MAX} forwards at once.`
      );
    }
    return answer(c, () => c.json({ stamps: forwards.stamps(app.extensionId, viewer, ids) }));
  });

  router.get('/:id/forward/:forwardId/replies', (c) => {
    // The same bar as sending, less the body: an agent's answers to the
    // person are theirs to read, not a relayed caller's or a local program's.
    const refusal = refuseForwardRead(honoRequestFacts(c));
    if (refusal) return refuse(c, 'person_required', REFUSAL_MESSAGE[refusal]);
    const app = appFor(c);
    if (app instanceof Response) return app;
    const viewer = ownerOf(c);
    if (!viewer) return refuse(c, 'person_required', REFUSAL_MESSAGE['not-the-owner']);
    return answer(c, () =>
      c.json({ replies: forwards.replies(app.extensionId, viewer, c.req.param('forwardId')) })
    );
  });

  router.get('/:id/forward-agents', (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    // Withheld from agents, as the leaf is in `config_get`, and held to the
    // same signed-in session as a forward: no headerless local caller.
    const readRefusal = refuseForwardRead(honoRequestFacts(c));
    if (readRefusal) return refuse(c, 'person_required', REFUSAL_MESSAGE[readRefusal]);
    if (!extensionManager.get(id)) return c.json({ error: `No mini app named ${id}.` }, 404);
    // A listed agent that is gone still reads back, so the person can remove it.
    return answer(c, () => c.json(forwards.agents(id)));
  });

  router.put('/:id/forward-agents', (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    const refused = refusedNotAPerson(c, FORWARD_AGENTS_BAR);
    if (refused) return refused;
    // The forward bar too (Security M1 on #3207): with the password off at this
    // computer, the person bar lets a headerless local caller through, and this
    // list decides who receives the person's words.
    const why = refuseForward(honoRequestFacts(c), c.req.header('content-type'));
    if (why) return refuse(c, 'person_required', REFUSAL_MESSAGE[why]);
    const record = extensionManager.get(id);
    if (!record) return c.json({ error: `No mini app named ${id}.` }, 404);
    if (!asksToForward(record)) return refuse(c, 'invalid_input', NO_FORWARD_DECLARED);
    const body = ForwardAgentsBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) {
      return refuse(
        c,
        'invalid_input',
        `Send { agentIds }, at most ${FORWARD_AGENTS_MAX}, or [] for none.`
      );
    }
    return answer(c, () => {
      // By id only, and only agents Mesh knows: a name or a stale id adds nothing.
      if (body.data.agentIds.some((agentId) => !forwards.registered(agentId))) {
        return refuse(c, 'not_found', 'There is no agent with that id here.');
      }
      // Recorded in the audit trail as a settings change by `setForwardAgents`.
      setForwardAgents(id, body.data.agentIds);
      return c.json(forwards.agents(id));
    });
  });
}

/**
 * Record one forward, or a refused one. The actor is the person (the
 * request's own audit scope); the target is the mini app it came through, so
 * a search for what one mini app did finds every forward. The words are not
 * copied here: they are in the Direct chat, by the forward's id.
 */
function auditForward(
  app: { extensionId: string; extensionName: string },
  outcome: 'ok' | 'refused' | 'failed',
  why?: string,
  sent?: { forwardId: string; agentId: string; itemId: string }
): void {
  recordAudit({
    action: 'extension.person_forward',
    operation: 'create',
    outcome,
    target: { type: 'extension', id: app.extensionId, name: app.extensionName },
    ...(sent
      ? {
          change: [
            { field: 'forwardEntryId', after: sent.forwardId },
            { field: 'agentId', after: sent.agentId },
            { field: 'itemId', after: sent.itemId },
          ],
        }
      : {}),
    summary:
      outcome === 'ok'
        ? `Forwarded a comment to an agent through ${app.extensionName}`
        : `A comment through ${app.extensionName} was not forwarded`,
    ...(why ? { error: why } : {}),
  });
}
