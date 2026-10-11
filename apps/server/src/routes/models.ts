import { creditsCapabilitiesFor } from '../services/core/cloud/credits-protocols.js';
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { creditsMenuFor } from '../services/core/cloud/credits-models.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { sessionRunsOnCredits } from '../services/core/cloud/credits-model-gate.js';

const router = new Hono<ApiEnv>();

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
 * **On DorkOS credits the menu is the service's, once it says which protocols
 * its models are on** (DOR-2636). A session that runs on credits (its bound
 * account; else the person's pick, `account`; else the ladder for `cwd`), or a
 * caller asking about credits directly (`account=dorkos-credits` with no
 * session, as the agent settings do), gets only the models credits serve on
 * the runtime's protocol, the service's recommended one first. When the
 * service cannot be read now, the last list it answered stands, each row
 * marked `creditsListOutOfDate`. A service that says nothing about protocols,
 * or no list ever read, leaves the runtime's own menu in place, as before. With no session and no `account`,
 * the answer is always the runtime's own catalog, the menu every sign-in shares.
 */
router.get('/', async (c) => {
  const query = readQuery(c);
  const runtimeParam = queryString(query.runtime);
  const sessionId = queryString(query.sessionId);
  const account = queryString(query.account);
  const cwd = queryString(query.cwd);

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

  const onCredits = sessionId
    ? await sessionRunsOnCredits(runtime, sessionId, { accountHint: account, cwd })
    : account === CREDITS_ACCOUNT_ID && runtime.getCapabilities().credits !== undefined;
  if (onCredits) {
    const menu = await creditsMenuFor(creditsCapabilitiesFor(runtime, sessionId));
    if (menu.kind === 'filtered') return c.json({ models: menu.models });
    // The service says nothing about protocols: the runtime's own menu, as before.
  }

  const models = await runtime.getSupportedModels(sessionId);
  return c.json({ models });
});

export default router;
