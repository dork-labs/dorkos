import { Router } from 'express';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { creditsModelsFor } from '../services/core/cloud/credits-models.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { sessionRunsOnCredits } from './session-model-gate.js';

const router = Router();

/** The one query value read as a string, or `undefined`. */
function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * GET /api/models — list available models for the resolved runtime.
 *
 * Resolution priority:
 * 1. An explicit `runtime` query param — validated against the registry (400 on
 *    unknown). This is the not-yet-started-session path: a brand-new session has
 *    no `session_metadata` row, so resolving by `sessionId` alone would infer
 *    the default (`claude-code`) and wrongly show Anthropic models for a Codex
 *    session before its first message.
 * 2. Else a `sessionId` — resolves the runtime owning that session.
 * 3. Else the default runtime — the legitimate cold-discovery path for screens
 *    without session context (onboarding, first-run, agent creation).
 *
 * **On DorkOS credits the menu is the service's** (DOR-2636). A session that
 * runs on credits (its bound account; else the person's pick, `account`; else
 * the ladder for `cwd`), or a caller asking about credits directly
 * (`account=dorkos-credits` with no session, as the agent settings do), gets
 * only the models credits serve on the runtime's protocol, the service's
 * recommended one first. When that list cannot be read the answer is 503 and
 * no menu at all: offering the runtime's own models would offer models credits
 * may not serve. With no session and no `account`, the answer is always the
 * runtime's own catalog, because that is the menu for every sign-in.
 */
router.get('/', async (req, res) => {
  const runtimeParam = queryString(req.query.runtime);
  const sessionId = queryString(req.query.sessionId);
  const account = queryString(req.query.account);
  const cwd = queryString(req.query.cwd);

  let runtime: AgentRuntime;
  if (runtimeParam !== undefined) {
    if (!runtimeRegistry.has(runtimeParam)) {
      return res.status(400).json({ error: `Unknown runtime: ${runtimeParam}` });
    }
    runtime = runtimeRegistry.get(runtimeParam);
  } else if (sessionId) {
    runtime = await runtimeRegistry.resolveForSession(sessionId);
  } else {
    // cold discovery: no session context (onboarding, first-run)
    runtime = runtimeRegistry.getDefault();
  }

  const onCredits = sessionId
    ? await sessionRunsOnCredits(runtime, sessionId, { accountHint: account, cwd })
    : account === CREDITS_ACCOUNT_ID && runtime.getCapabilities().credits !== undefined;
  if (onCredits) {
    const models = await creditsModelsFor(runtime.getCapabilities());
    if (models === null) {
      return res.status(503).json({
        error: "Couldn't load the models DorkOS credits cover. Try again in a moment.",
        code: 'CREDITS_MODELS_UNAVAILABLE',
      });
    }
    return res.json({ models });
  }

  const models = await runtime.getSupportedModels();
  res.json({ models });
});

export default router;
