/**
 * `/api/mcp-servers`: the MCP servers a person adds once for every agent, in
 * Connections → MCP servers (DOR-3213).
 *
 * **Person-only, every route.** These are not capabilities, so no agent tool,
 * capability call or approval token reaches them. Reading takes a person
 * ({@link clearsTheAgentBar}); changing takes the owner at this computer
 * ({@link refuseFrontDoorChange}), the bar for every setting that decides what
 * code DorkOS runs and which credentials it holds, because a global server
 * runs in every agent's session.
 *
 * Secret env and header values go in here, typed by the person, and never come
 * back out: every answer is a {@link GlobalMcpServerView}, which carries a
 * secret's name and nothing else.
 *
 * @module routes/mcp-servers
 */
import { Hono, type Context } from 'hono';
import {
  GlobalMcpServerInputSchema,
  GlobalMcpServerPatchSchema,
} from '@dorkos/shared/global-mcp-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar, refuseFrontDoorChange } from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import {
  GlobalMcpStoreError,
  type GlobalMcpStore,
} from '../services/mesh/global-mcp/global-mcp-store.js';

/** Refusal code for a caller that is not a person. */
export const MCP_SERVERS_PERSON_ONLY = 'MCP_SERVERS_PERSON_ONLY';

/** How each store refusal answers. */
const STATUS_BY_CODE = {
  not_found: 404,
  name_taken: 409,
  reserved_name: 409,
  oauth_unsupported: 422,
  unreadable: 503,
} as const;

/** The bar for reading the list: a person, never an agent. */
function refuseRead(c: Context<ApiEnv>): Response | undefined {
  if (clearsTheAgentBar(honoRequestFacts(c))) return undefined;
  return c.json(
    { error: 'Only a person can see these servers, in the app.', code: MCP_SERVERS_PERSON_ONLY },
    403
  );
}

/** The bar for changing it: the owner, at this computer. */
function refuseWrite(c: Context<ApiEnv>): Response | undefined {
  const refusal = refuseFrontDoorChange(honoRequestFacts(c), 'MCP servers for every agent');
  return refusal ? c.json({ error: refusal.error, code: refusal.code }, 403) : undefined;
}

/** A store refusal as an answer; anything else is rethrown. */
function storeRefusal(c: Context<ApiEnv>, err: unknown): Response {
  if (err instanceof GlobalMcpStoreError) {
    return c.json({ error: err.message, code: err.code }, STATUS_BY_CODE[err.code]);
  }
  throw err;
}

/**
 * Build the routes mounted at `/api/mcp-servers`.
 *
 * @param store - The person's global MCP servers.
 */
export function createMcpServerRoutes(store: GlobalMcpStore): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /** GET /api/mcp-servers — every server, secrets by name only. */
  router.get('/', (c) => refuseRead(c) ?? c.json({ servers: store.list() }));

  /** POST /api/mcp-servers — add a server for every agent. */
  router.post('/', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    const parsed = GlobalMcpServerInputSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'That server is not complete.' }, 400);
    try {
      const server = await store.add(parsed.data);
      logger.info('[mcp-servers] added a server for every agent', { name: server.name });
      return c.json(server, 201);
    } catch (err) {
      return storeRefusal(c, err);
    }
  });

  /** PUT /api/mcp-servers/:name — replace a server; its secrets are typed again. */
  router.put('/:name', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    const parsed = GlobalMcpServerInputSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'That server is not complete.' }, 400);
    try {
      const server = await store.replace(c.req.param('name'), parsed.data);
      logger.info('[mcp-servers] replaced a server for every agent', { name: server.name });
      return c.json(server);
    } catch (err) {
      return storeRefusal(c, err);
    }
  });

  /** PATCH /api/mcp-servers/:name — `{ enabled?, excludedAgents? }`. */
  router.patch('/:name', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    const parsed = GlobalMcpServerPatchSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Send enabled or excludedAgents.' }, 400);
    try {
      return c.json(await store.patch(c.req.param('name'), parsed.data));
    } catch (err) {
      return storeRefusal(c, err);
    }
  });

  /** DELETE /api/mcp-servers/:name — remove a server and its stored secrets. */
  router.delete('/:name', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    try {
      await store.remove(c.req.param('name'));
      logger.info('[mcp-servers] removed a server for every agent', {
        name: c.req.param('name'),
      });
      return c.body(null, 204);
    } catch (err) {
      return storeRefusal(c, err);
    }
  });

  return router;
}
