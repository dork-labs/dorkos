/** Route-bound confirmation for account credentials and signing out other devices. */
import type { Context } from 'hono';
import type { StepUpActionKind } from '@dorkos/shared/step-up';
import type { ApiEnv } from './api-chain.js';
import { honoRequestFacts, type RequestFacts } from './request-facts.js';
import type { Auth } from '../services/core/auth/index.js';
import { fromNodeHeaders } from '../services/core/auth/index.js';
import { recordApiKeyCreationRoute } from '../services/core/auth/remote-mcp-audit.js';
import { refuseFrontDoorChange, presentsProgramCredential } from '../lib/caller-authority.js';
import { currentServerRole } from '../lib/server-role.js';
import { runFrontDoorWrite } from '../routes/front-door-step-up.js';

/** Hold a fixed auth write; the hub keeps its existing OAuth owner ceremony. */
export async function confirmAuthWrite(options: {
  c: Context<ApiEnv>;
  auth: Auth;
  forHandler: Request;
  facts: RequestFacts;
  headers: RequestFacts['headers'];
  authPath: string;
  apiKeyWrite: boolean;
  signOutKind: StepUpActionKind | undefined;
}): Promise<Response> {
  const { c, auth, forHandler, facts, headers, authPath, apiKeyWrite, signOutKind } = options;
  // Auth routes run before the session gate. Resolve a real, route-bound
  // browser session here; a key can never be used to make another key.
  if (presentsProgramCredential(facts)) {
    return c.json(
      { error: 'Only the owner can change access, in the app.', code: 'not-a-person' },
      403
    );
  }
  const found = await auth.api.getSession({
    headers: fromNodeHeaders(headers),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!found) return c.json({ error: 'Sign in to change access.', code: 'not-a-person' }, 401);
  c.set('user', { userId: found.user.id, credential: 'cookie', sessionId: found.session.id });
  const input: unknown = await forHandler.json().catch(() => (signOutKind ? {} : null));
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return c.json({ error: 'Send the action as an object.' }, 400);
  }
  const updating = authPath.endsWith('/update');
  const body = JSON.stringify(input);
  const url = forHandler.url;
  const method = forHandler.method;
  const run = async (confirming: ReturnType<typeof honoRequestFacts>) => {
    const committedHeaders = fromNodeHeaders(confirming.headers);
    committedHeaders.delete('content-length');
    committedHeaders.delete('transfer-encoding');
    committedHeaders.set('content-type', 'application/json');
    const response = await auth.handler(
      new Request(url, { method, headers: committedHeaders, body })
    );
    return apiKeyWrite && !updating ? recordApiKeyCreationRoute(confirming, response) : response;
  };
  if (
    signOutKind === 'devices.sign-out-one' &&
    (input as Record<string, unknown>).token === found.session.token
  )
    return run(honoRequestFacts(c));
  const subject = apiKeyWrite ? 'API keys' : 'signed-in devices';
  const refusal = refuseFrontDoorChange(honoRequestFacts(c), subject);
  if (refusal) return c.json({ error: refusal.error, code: refusal.code }, 403);
  // M2 preserves the hub's existing key flow. A hub has its own owner
  // bar and no local password ceremony; its classifier is never an
  // encrypted computer route (`passwordMayCross` excludes hubs).
  if (currentServerRole() === 'hub') return run(honoRequestFacts(c));
  let reason = 'Create an API key for DorkOS.';
  if (signOutKind) reason = 'Sign other devices out of DorkOS.';
  else if (updating) reason = 'Save these API key settings.';
  return runFrontDoorWrite(c, {
    kind: signOutKind ?? (updating ? 'api-key.update' : 'api-key.create'),
    target: apiKeyWrite ? 'api-keys' : 'signed-in-devices',
    input,
    reason,
    subject,
    run,
  });
}
