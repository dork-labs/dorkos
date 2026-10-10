import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { CommandsQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';

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
 */
router.get('/', async (c) => {
  const parsed = CommandsQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
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
        return c.json({ error: `Unknown runtime: ${runtimeParam}` }, 400);
      }
      runtime = runtimeRegistry.get(runtimeParam);
    } else if (sessionId) {
      runtime = await runtimeRegistry.resolveForSession(sessionId);
    } else {
      // cold discovery: no session context (onboarding, first-run)
      runtime = runtimeRegistry.getDefault();
    }
    const commands = await runtime.getCommands(refresh, validatedCwd);
    return c.json(commands);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    logger.error('[commands] GET / failed', { err, cwd: parsed.data.cwd, sessionId });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
