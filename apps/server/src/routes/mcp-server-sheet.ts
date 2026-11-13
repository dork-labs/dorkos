/**
 * `/api/mcp-servers/:name/tools` and `/:name/allows`: what a global MCP
 * server's sheet shows, "Who uses it without asking" (DOR-4118).
 *
 * Person-only, like every `/api/mcp-servers` route; none is a capability, so no
 * agent tool reaches them and nothing they return enters an agent's context.
 *
 * - `GET /:name/tools` checks the server's tools when a person opens the sheet.
 *   A server that is off, or that the store would not hand an agent, is never
 *   started (`not-checked`).
 * - `GET /:name/allows` lists the standing yeses agents' folders hold for it.
 * - `DELETE /:name/allows` (`{ agentId, rule }`) removes one, from the folder
 *   the registry names for that agent. Owner at this computer only, and audited.
 *
 * @module routes/mcp-server-sheet
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import { notify } from '../services/notifications/notification-service.js';
import {
  removeStandingAllow,
  StandingAllowUndoError,
  UNDOABLE_RULE,
} from '../services/mesh/global-mcp/global-mcp-allow-undo.js';
import {
  readStandingAllows,
  standingAllowBreadth,
  type StandingAllowAgent,
} from '../services/mesh/global-mcp/global-mcp-standing-allows.js';
import type { GlobalMcpStore } from '../services/mesh/global-mcp/global-mcp-store.js';
import {
  checkServerTools,
  type GlobalMcpToolLedger,
  type ServerToolsCheck,
} from '../services/mesh/global-mcp/global-mcp-tools.js';

/** What the sheet routes need beyond the store. */
export interface McpServerSheetDeps {
  /** Every registered agent, with the home the registry holds for it. */
  agents: () => readonly StandingAllowAgent[];
  /** Where a server's first-seen tools are kept. */
  ledger: GlobalMcpToolLedger;
  /**
   * Told about tools a server added since its last check, when some agent
   * allows every tool on it. The Inbox line by default.
   */
  onToolsAdded?: (server: string, added: readonly string[], agentNames: string[]) => void;
  /** The check; the real probe by default. A seam for tests. */
  check?: typeof checkServerTools;
}

/** The two bars every `/api/mcp-servers` route answers to. */
export interface McpServerBars {
  /** A person, never an agent. */
  read: (c: Context<ApiEnv>) => Response | undefined;
  /** The owner, at this computer. */
  write: (c: Context<ApiEnv>) => Response | undefined;
}

const UndoSchema = z.object({
  agentId: z.string().min(1).max(200),
  rule: z.string().regex(UNDOABLE_RULE),
});

const UNDO_STATUS: Record<StandingAllowUndoError['code'], 400 | 409> = {
  'bad-rule': 400,
  'not-a-real-file': 409,
  unreadable: 409,
};

/** One Inbox line per added tool; the dedupe key makes each one say it once. */
function sayToolsAdded(server: string, added: readonly string[], agentNames: string[]): void {
  for (const tool of added) void notify('mcp-server.tool_added', { server, tool, agentNames });
}

/**
 * Add the sheet's routes to the `/api/mcp-servers` router.
 *
 * @param router - The `/api/mcp-servers` router.
 * @param store - The person's global MCP servers.
 * @param bars - The read and write bars the other routes use.
 * @param deps - The registry view, the ledger and the seams.
 */
export function addMcpServerSheetRoutes(
  router: Hono<ApiEnv>,
  store: GlobalMcpStore,
  bars: McpServerBars,
  deps: McpServerSheetDeps
): void {
  const unknown = (c: Context<ApiEnv>) =>
    c.json({ error: 'There is no MCP server by that name.', code: 'not_found' }, 404);

  /** GET /api/mcp-servers/:name/tools — what it can do, checked now. */
  router.get('/:name/tools', async (c) => {
    const refusal = bars.read(c);
    if (refusal) return refusal;
    const name = c.req.param('name');
    if (!store.has(name)) return unknown(c);
    const check = deps.check ?? checkServerTools;
    const result: ServerToolsCheck = await check(store.connectionToCheck(name), name, deps.ledger);
    if (result.status === 'ok' && result.added.length > 0) {
      const wide = (await readStandingAllows(name, deps.agents()))
        .filter((allow) => allow.breadth === 'server')
        .map((allow) => allow.agentName);
      if (wide.length > 0) (deps.onToolsAdded ?? sayToolsAdded)(name, result.added, wide);
    }
    return c.json(result);
  });

  /** GET /api/mcp-servers/:name/allows — who may use it without asking. */
  router.get('/:name/allows', async (c) => {
    const refusal = bars.read(c);
    if (refusal) return refusal;
    const name = c.req.param('name');
    if (!store.has(name)) return unknown(c);
    return c.json({ allows: await readStandingAllows(name, deps.agents()) });
  });

  /** DELETE /api/mcp-servers/:name/allows — `{ agentId, rule }`: undo one standing yes. */
  router.delete('/:name/allows', async (c) => {
    const refusal = bars.write(c);
    if (refusal) return refusal;
    const name = c.req.param('name');
    if (!store.has(name)) return unknown(c);
    const parsed = UndoSchema.safeParse(readJsonBody(c));
    if (!parsed.success || standingAllowBreadth(parsed.data.rule, name) === null) {
      return c.json(
        { error: `Send an agent and one ${name} rule to undo.`, code: 'bad_rule' },
        400
      );
    }
    const { agentId, rule } = parsed.data;
    // The folder comes from the registry, never from the request.
    const agent = deps.agents().find((candidate) => candidate.id === agentId);
    if (!agent) return c.json({ error: 'There is no agent by that id.', code: 'not_found' }, 404);
    let outcome: 'removed' | 'not-found';
    try {
      outcome = await removeStandingAllow(agent.home, rule);
    } catch (err) {
      if (!(err instanceof StandingAllowUndoError)) throw err;
      recordAudit({
        action: 'mcp-server.allow-undone',
        operation: 'remove',
        target: { type: 'agent', id: agent.id, name: agent.name },
        outcome: 'refused',
        error: err.message,
        summary: `Couldn't undo ${rule} for ${agent.name}`,
      });
      return c.json({ error: err.message, code: err.code }, UNDO_STATUS[err.code]);
    }
    if (outcome === 'not-found') {
      return c.json({ error: `${agent.name} no longer has that rule.`, code: 'not_found' }, 404);
    }
    recordAudit({
      action: 'mcp-server.allow-undone',
      operation: 'remove',
      target: { type: 'agent', id: agent.id, name: agent.name },
      outcome: 'ok',
      change: [{ field: 'permissions.allow', before: rule, after: null }],
      reason: `${agent.home}/.claude/settings.local.json`,
      summary: `Undid ${rule} for ${agent.name}`,
    });
    logger.info('[mcp-servers] undid a standing yes', { server: name, agentId, rule });
    return c.body(null, 204);
  });
}
