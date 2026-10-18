/**
 * `/api/hub/agent-grants`: what the hub's owner allows its agents beyond their
 * own settings (DOR-2939 part 6, `specs/everything-is-a-space/design-agent-
 * computers.md` §3), kept in the owner-only grants file
 * (`services/core/tool-bridge/setup-grants-store.ts`).
 *
 * - `GET /` reads the grants.
 * - `PUT /dorkbot-setup` `{ granted }` turns DorkBot's setup level on or off:
 *   whether DorkBot, working on an agent computer, may use the setup tools.
 * - `POST /pairs` `{ from, to }` allows agent `from` to start full turns for
 *   agent `to` on another computer; `DELETE /pairs/:from/:to` takes it back.
 *
 * Only a serving hub answers; elsewhere every path is the `/api` 404. **Only
 * the person's own browser sign-in reaches these routes, reads included**, as
 * `hub-computers.ts` decides it: a caller presenting agent identity is
 * refused, and so is any credential but the session cookie, since an API key
 * is what an agent or an MCP client may hold. Every change is audited,
 * readable by the person who made it.
 *
 * Follow-up: the design asks for a recent sign-in before a grant changes. The
 * server has no recent-sign-in check yet, so these routes ask for the session
 * cookie alone until one exists.
 *
 * @module routes/hub-agent-grants
 */
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { errorBody } from '../lib/route-utils.js';
import { currentServerRole } from '../lib/server-role.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { currentAuditActor } from '../services/audit/audit-context.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import {
  AgentPairBodySchema,
  DorkBotSetupBodySchema,
  allowAgentPair,
  readSetupGrants,
  removeAgentPair,
  setDorkBotSetupGrant,
  type SetupGrants,
} from '../services/core/tool-bridge/index.js';

/** What the routes read and write, injectable for tests. */
export interface HubAgentGrantRoutesDeps {
  /** Whether this server is a hub. */
  isHub: () => boolean;
  /** The grants now. */
  read: () => SetupGrants;
  /** Turn DorkBot's setup level on or off. */
  setDorkBotSetup: (granted: boolean) => Promise<SetupGrants>;
  /** Allow a one-way pair. */
  allowPair: (from: string, to: string) => Promise<SetupGrants>;
  /** Take a pair back. */
  removePair: (from: string, to: string) => Promise<SetupGrants>;
}

const liveDeps: HubAgentGrantRoutesDeps = {
  isHub: () => currentServerRole() === 'hub',
  read: () => readSetupGrants(),
  setDorkBotSetup: (granted) => setDorkBotSetupGrant(granted),
  allowPair: (from, to) => allowAgentPair(from, to),
  removePair: (from, to) => removeAgentPair(from, to),
};

const NOT_FOUND = errorBody('Not found', 'API_NOT_FOUND');
const INVALID = errorBody('That request is not valid.', 'INVALID_REQUEST');

/** Record an owner's grant change, readable by them alone. */
function auditGrantChange(entry: {
  action: string;
  operation: 'create' | 'modify' | 'remove';
  summary: string;
  target: { type: string; id: string };
}): void {
  const scope = currentAuditActor();
  recordAudit({
    ...entry,
    outcome: 'ok',
    ...(scope ? { visibility: 'participants', participants: [scope.actor.accountId] } : {}),
  });
}

/**
 * The `/api/hub/agent-grants` routes.
 *
 * @param deps - Override for tests; defaults to the live hub and grants file.
 */
export function createHubAgentGrantRoutes(deps: HubAgentGrantRoutesDeps = liveDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    if (!deps.isHub()) return c.json(NOT_FOUND, 404);
    if (presentsAgentIdentity(honoRequestFacts(c))) {
      return c.json(errorBody("Agents can't change what agents may do.", 'FORBIDDEN'), 403);
    }
    // The gate already asked for a credential; this holds even if it ever did not.
    const user = c.get('user');
    if (!user)
      return c.json(errorBody('Sign in to change what agents may do.', 'UNAUTHORIZED'), 401);
    if (user.credential !== 'cookie') {
      return c.json(errorBody('Change this from your own signed-in browser.', 'FORBIDDEN'), 403);
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  router.get('/', (c) => c.json(deps.read()));

  router.put('/dorkbot-setup', async (c) => {
    const body = DorkBotSetupBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json(INVALID, 400);
    const grants = await deps.setDorkBotSetup(body.data.granted);
    auditGrantChange({
      action: 'hub.agent_grants.dorkbot_setup',
      operation: 'modify',
      summary: body.data.granted
        ? 'Let DorkBot set things up from a cloud computer'
        : 'Stopped DorkBot setting things up from a cloud computer',
      target: { type: 'agent', id: 'dorkbot' },
    });
    return c.json(grants);
  });

  router.post('/pairs', async (c) => {
    const body = AgentPairBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json(INVALID, 400);
    let grants: SetupGrants;
    try {
      grants = await deps.allowPair(body.data.from, body.data.to);
    } catch {
      return c.json(errorBody('Too many pairs. Remove one first.', 'TOO_MANY_PAIRS'), 409);
    }
    auditGrantChange({
      action: 'hub.agent_grants.pair.create',
      operation: 'create',
      summary: 'Let one agent start full turns for another',
      target: { type: 'agent', id: `${body.data.from}->${body.data.to}` },
    });
    return c.json(grants);
  });

  router.delete('/pairs/:from/:to', async (c) => {
    const pair = AgentPairBodySchema.safeParse({
      from: c.req.param('from'),
      to: c.req.param('to'),
    });
    if (!pair.success) return c.json(INVALID, 400);
    const grants = await deps.removePair(pair.data.from, pair.data.to);
    auditGrantChange({
      action: 'hub.agent_grants.pair.remove',
      operation: 'remove',
      summary: 'Stopped one agent starting full turns for another',
      target: { type: 'agent', id: `${pair.data.from}->${pair.data.to}` },
    });
    return c.json(grants);
  });

  return router;
}
