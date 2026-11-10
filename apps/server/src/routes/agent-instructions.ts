/**
 * The agent instructions views, for a person (spec `context-viewer` phase 3).
 *
 * - `GET /api/agent-instructions`           what every agent is told, as a template
 * - `GET /api/agents/:id/instructions`      what one agent will be told
 *
 * Both take `?runtime=&place=&level=`. Both are the PERSON's: an agent caller
 * is refused, and with login on only a browser session counts. The person's
 * template carries per-block override counts; an agent never reads those, nor
 * any other agent's preview (Security ruling 8). An agent reads the template,
 * without values, through its own observe tool (`agent-instructions-capability.ts`).
 *
 * Read only. Nothing here edits a block: that is phase 5, behind its own
 * person-only routes and deep review.
 *
 * @module routes/agent-instructions
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  InstructionsQuerySchema,
  InstructionsRuntimeSchema,
  type InstructionsRuntime,
} from '@dorkos/shared/agent-instructions-schemas';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { validationFailureBody } from '../lib/route-utils.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { resolveAgentHome, homeOf } from '../services/core/agent-identity/index.js';
import { buildInstructionsView } from '../services/runtimes/context-preview/preview.js';

/** What the routes read, resolved per request. */
export interface AgentInstructionsRouterDeps {
  /** The registered folder of an agent, or `undefined` when there is no such agent. */
  agentPath(agentId: string): string | undefined;
  /** The runtime an agent at a folder runs on. */
  runtimeType(agentPath: string): Promise<string>;
  /** The agent registry, or `undefined` before boot finishes. */
  meshCore(): AgentRegistryPort | undefined;
}

/** The sentence an agent caller reads. */
const ONLY_A_PERSON = 'Only a person can read this view. Agents can read the template.';

/**
 * Refuse anything but a person.
 *
 * @returns The refusal, or `undefined` to carry on.
 */
function refuseNonPerson(c: Context<ApiEnv>): Response | undefined {
  const facts = honoRequestFacts(c);
  const authority = resolveDecisionAuthority(readCallerAuthority(facts));
  if (!authority.allowed) {
    return c.json(
      { error: ONLY_A_PERSON, code: authority.code },
      authority.status as ContentfulStatusCode
    );
  }
  const cookie = requireOperatorCookieUnderLogin(facts, 'agent instructions');
  if (cookie) {
    return c.json(
      { error: ONLY_A_PERSON, code: cookie.code },
      cookie.status as ContentfulStatusCode
    );
  }
  return undefined;
}

/**
 * The viewer's runtime for an agent's own runtime, defaulting to Claude Code
 * for one the viewer cannot show.
 *
 * @param type - The agent's runtime type.
 */
function viewerRuntime(type: string): InstructionsRuntime {
  const parsed = InstructionsRuntimeSchema.safeParse(type);
  return parsed.success ? parsed.data : 'claude-code';
}

/**
 * The agent instructions routes, to mount at `/api`. Only their two concrete
 * paths are registered.
 *
 * @param deps - How to find an agent and its runtime.
 */
export function createAgentInstructionsRoutes(deps: AgentInstructionsRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/agent-instructions', async (c) => {
    const refusal = refuseNonPerson(c);
    if (refusal) return refusal;
    const query = InstructionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    return c.json(
      await buildInstructionsView({
        runtime: query.data.runtime ?? 'claude-code',
        place: query.data.place,
        level: query.data.level,
        audience: 'person',
      })
    );
  });

  router.get('/agents/:id/instructions', async (c) => {
    const refusal = refuseNonPerson(c);
    if (refusal) return refusal;
    const query = InstructionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    const id = c.req.param('id');
    const folder = deps.agentPath(id);
    const home = folder ? homeOf(resolveAgentHome(folder)) : undefined;
    if (!folder || !home) {
      return c.json({ error: `No agent with id "${id}".`, code: 'UNKNOWN_AGENT' }, 404);
    }
    const runtime = query.data.runtime ?? viewerRuntime(await deps.runtimeType(folder));
    return c.json(
      await buildInstructionsView({
        runtime,
        place: query.data.place,
        level: query.data.level,
        audience: 'person',
        agent: { id, home, cwd: folder },
        meshCore: deps.meshCore() ?? null,
      })
    );
  });

  return router;
}
