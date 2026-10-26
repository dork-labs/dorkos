/**
 * `api.forward` on the server (DOR-3325): a mini app's page forwards what the
 * person typed to the agent they picked for it, as their own words, under
 * `/api/extensions/:id/forward`.
 *
 * | Route                                 | What                          | Bar         |
 * | ------------------------------------- | ----------------------------- | ----------- |
 * | `POST /:id/forward`                   | forward the typed text        | forward bar |
 * | `GET  /:id/forward/:forwardId/replies`| the agent's answers           | no agent    |
 * | `GET  /:id/forward-agent`             | the agent the person picked   | no agent    |
 * | `PUT  /:id/forward-agent`             | pick it                       | person bar; Wi-Fi refuses (`wifi-level.ts`) |
 *
 * **DorkOS reads the forward's body itself.** The page POSTs here directly;
 * no extension server code runs between the person's request and the post in
 * their Direct chat, so DorkOS can tell what they typed from what code made
 * up. The agent comes from the person's pick, never from the body.
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
import {
  FORWARD_ITEM_ID_MAX_CHARS,
  FORWARD_ITEM_TITLE_MAX_CHARS,
  FORWARD_TEXT_MAX_CHARS,
  type ExtensionStatus,
  type ForwardErrorCode,
} from '@dorkos/extension-api';
import { getRoomService, type AuthorRecord } from '../services/rooms/index.js';
import { getDirectChats } from '../services/rooms/direct-chat/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import {
  PersonForwardError,
  PersonForwards,
  forwardAgentOf,
  setForwardAgent,
  type PersonForwardDeps,
} from '../services/extensions/forward/person-forward.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { wifiTurnBound } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { readJsonBody } from '../http/request-body.js';
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
    'Nothing was sent. Turn on “Ask for a password on this computer too” so DorkOS can tell your words are yours.',
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
    itemId: z.string().trim().min(1).max(FORWARD_ITEM_ID_MAX_CHARS),
    itemTitle: z.string().max(FORWARD_ITEM_TITLE_MAX_CHARS).optional(),
  })
  .strict();

const ForwardAgentBodySchema = z
  .object({ agentId: z.string().min(1).max(200).nullable() })
  .strict();

/** What the person bar says when it refuses a change of agent. */
const FORWARD_AGENT_BAR: PersonBarCopy = {
  error: 'Only a person can choose the agent a mini app forwards to.',
  code: 'forward_agent_person_required',
  subject: 'which agent a mini app forwards to',
  crossSite: (origin) =>
    `Nothing changed. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can choose the agent a mini app forwards to.`,
  agent: 'Nothing changed. Only a person can choose the agent a mini app forwards to.',
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
 * Mount the `api.forward` routes and the forward-agent setting on the
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

  router.post('/:id/forward', (c) => {
    // The bar runs first, so a refused attempt is recorded whoever made it.
    const auditRefused = (why: string) => {
      const extensionId = c.req.param('id');
      const record = safeExtId.test(extensionId) ? extensionManager.get(extensionId) : undefined;
      if (record)
        auditForward({ extensionId, extensionName: record.manifest.name }, 'refused', why);
    };
    const facts = honoRequestFacts(c);
    const refusal = refuseForward(facts, c.req.header('content-type'));
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
    const body = ForwardBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) {
      auditRefused('invalid_input');
      return refuse(
        c,
        'invalid_input',
        `Send { text, itemId } and an optional itemTitle. Text is 1 to ${FORWARD_TEXT_MAX_CHARS.toLocaleString('en-US')} characters.`
      );
    }
    try {
      const bound = wifiTurnBound(facts);
      const receipt = forwards.forward({
        extensionId: app.extensionId,
        appName: app.extensionName,
        viewer,
        text: body.data.text,
        itemId: body.data.itemId,
        ...(body.data.itemTitle !== undefined ? { itemTitle: body.data.itemTitle } : {}),
        ...(bound !== undefined ? { bound } : {}),
      });
      auditForward(app, 'ok', undefined, {
        forwardId: receipt.id,
        agentId: receipt.agent.id,
        itemId: body.data.itemId,
      });
      return c.json(receipt, 201);
    } catch (err) {
      if (err instanceof PersonForwardError) {
        auditForward(app, 'refused', err.code);
        return refuse(c, err.code, err.message);
      }
      logger.error('[Extensions] A mini app forward failed', err);
      auditForward(app, 'failed');
      return refuse(c, 'unavailable', 'The comment was not sent. Try again.');
    }
  });

  router.get('/:id/forward/:forwardId/replies', (c) => {
    if (presentsAgentIdentity(honoRequestFacts(c))) {
      return refuse(c, 'person_required', 'Only the person can read a mini app’s forwards.');
    }
    const app = appFor(c);
    if (app instanceof Response) return app;
    const viewer = ownerOf(c);
    if (!viewer) return refuse(c, 'person_required', REFUSAL_MESSAGE['not-the-owner']);
    return answer(c, () =>
      c.json({ replies: forwards.replies(app.extensionId, viewer, c.req.param('forwardId')) })
    );
  });

  router.get('/:id/forward-agent', (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    // Withheld from agents, as the leaf is in `config_get`.
    if (presentsAgentIdentity(honoRequestFacts(c))) {
      return refuse(c, 'person_required', 'Only the person can see who a mini app forwards to.');
    }
    if (!extensionManager.get(id)) return c.json({ error: `No mini app named ${id}.` }, 404);
    return answer(c, () => {
      try {
        return c.json({ agent: forwards.agent(id) });
      } catch (err) {
        // A picked agent that is gone still reads back, so the person can change it.
        if (err instanceof PersonForwardError && err.code === 'not_found') {
          return c.json({ agent: null, missingAgentId: forwardAgentOf(id) ?? null });
        }
        throw err;
      }
    });
  });

  router.put('/:id/forward-agent', (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    const refused = refusedNotAPerson(c, FORWARD_AGENT_BAR);
    if (refused) return refused;
    const record = extensionManager.get(id);
    if (!record) return c.json({ error: `No mini app named ${id}.` }, 404);
    if (!asksToForward(record)) return refuse(c, 'invalid_input', NO_FORWARD_DECLARED);
    const body = ForwardAgentBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) {
      return refuse(c, 'invalid_input', 'Send { agentId }, or { agentId: null } for none.');
    }
    const agentId = body.data.agentId;
    if (agentId !== null && !deps.mesh()?.get(agentId)) {
      return refuse(c, 'not_found', 'There is no agent with that id here.');
    }
    // Recorded in the audit trail as a settings change by `setForwardAgent`.
    setForwardAgent(id, agentId);
    return answer(c, () => c.json({ agent: forwards.agent(id) }));
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
