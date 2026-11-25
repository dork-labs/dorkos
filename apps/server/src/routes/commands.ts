import { Hono } from 'hono';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { sessionAgentById } from '../services/core/agent-identity/session-agent.js';
import { CommandsQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { problem, validationProblem } from '@dorkos/http-kit';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';

const router = new Hono<ApiEnv>();

/**
 * GET /api/commands — list slash commands for the resolved runtime.
 *
 * Resolution priority (mirrors `GET /api/models`):
 * 1. An explicit `runtime` query param — validated against the registry (400 on
 *    unknown). This is the not-yet-started-session path: a brand-new session has
 *    no `session_metadata` row, so resolving by `sessionId` alone would infer
 *    the default (`claude-code`) and wrongly show Claude's commands for a Codex
 *    session before its first message.
 * 2. Else a `sessionId` — resolves the runtime owning that session.
 * 3. Else the default runtime — the legitimate cold-discovery path for screens
 *    without session context (onboarding, first-run, command palette before any
 *    session is active).
 *
 * With a `sessionId`, the session's agent is read from what the server recorded
 * for it, never from the request, so a session working outside its agent's home
 * also lists that agent's own skills (DOR-5250).
 */
router.get('/', async (c) => {
  const parsed = CommandsQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  const refresh = parsed.data.refresh === 'true';
  const runtimeParam = parsed.data.runtime;
  const sessionId = parsed.data.sessionId;
  try {
    let validatedCwd: string | undefined;
    if (parsed.data.cwd) {
      validatedCwd = await validateBoundary(parsed.data.cwd);
    }
    let runtime: AgentRuntime;
    if (runtimeParam !== undefined) {
      if (!runtimeRegistry.has(runtimeParam)) {
        return problem(c, 'invalid_request', {
          detail: 'No agent program by that name runs here.',
        });
      }
      runtime = runtimeRegistry.get(runtimeParam);
    } else if (sessionId) {
      runtime = await runtimeRegistry.resolveForSession(sessionId);
    } else {
      // cold discovery: no session context (onboarding, first-run). A server
      // with no runtime registered (a hub) has no commands to offer.
      if (!runtimeRegistry.has(runtimeRegistry.getDefaultType())) {
        return c.json({ commands: [], lastScanned: new Date().toISOString() });
      }
      runtime = runtimeRegistry.getDefault();
    }
    // A failed read lists the folder's commands alone rather than none.
    const agentPath = sessionId
      ? await sessionAgentById(sessionId).catch(() => undefined)
      : undefined;
    const commands = await runtime.getCommands(refresh, validatedCwd, agentPath);
    return c.json(commands);
  } catch (err) {
    if (err instanceof BoundaryError) return boundaryProblem(c, err);
    logger.error('[commands] GET / failed', { err, cwd: parsed.data.cwd, sessionId });
    return problem(c, 'internal_error', { detail: 'Couldn’t list the commands. Try again.' });
  }
});

export default router;
