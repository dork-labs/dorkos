/**
 * Owner-only, loopback DorkOS model setup, mounted at `/api/runtimes/doe` by
 * `routes/runtimes.ts`; metadata reads never resolve secrets.
 *
 * Every route is refused to a caller that is not at this computer. The two
 * writes also need the install's owner (`refuseUnlessAccountOwner`): an
 * identified agent or an approval-token holder is refused in every posture,
 * and under login only the owner's browser session gets through.
 *
 * @module routes/runtimes-doe-setup
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { DoeInferenceConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import { creditsModelsFor } from '../services/core/cloud/credits-models.js';
import { heldCreditsToken } from '../services/core/cloud/credits-inference.js';
import {
  creditsEndpointFor,
  creditsProtocolServed,
} from '../services/core/cloud/credits-protocols.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { storeDoeCredential } from '../services/runtimes/connect/doe-credentials.js';
import { ConnectError } from '../services/runtimes/connect/connect-error.js';
import { doeCreditsInUse, peekDoeCreditsPick } from '../services/runtimes/doe/auto-model.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';

// Preserve the persisted schema's validations while keeping key references server-owned.
const inferenceMetadataSchema = DoeInferenceConfigSchema.safeExtend({
  credentialRef: z.never().optional(),
  credentialEndpoint: z.never().optional(),
});

/** The 403 for a caller that is not at this computer, or `undefined` when it is. */
function refuseNonLoopback(c: Context<ApiEnv>): Response | undefined {
  if (isAtThisComputer(honoRequestFacts(c))) return undefined;
  return c.json({ error: 'Model setup is only available on this computer.' }, 403);
}

/** Credential and billing choices require the local owner, not merely a loopback socket. */
function refuseNonOwner(c: Context<ApiEnv>): Response | undefined {
  const notLocal = refuseNonLoopback(c);
  if (notLocal) return notLocal;
  const refusal = refuseUnlessAccountOwner(honoRequestFacts(c));
  if (!refusal) return undefined;
  return c.json({ error: 'Only the owner can change model settings.', code: refusal }, 403);
}

/**
 * Create the DorkOS model setup routes.
 *
 * @returns The routes, to mount at `/api/runtimes/doe`.
 */
export function createDoeSetupRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // Explicit DorkOS setup uses encrypted endpoint-bound keys, never a vendor login.
  router.get('/credits-models', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const protocol = z
      .enum(['anthropic-messages', 'openai-chat-completions', 'openai-responses'])
      .safeParse(readQuery(c).protocol);
    if (!protocol.success) {
      return c.json({ error: 'Choose a model protocol.' }, 400);
    }
    try {
      const models = await creditsModelsFor(protocol.data);
      const held = heldCreditsToken();
      return c.json({
        endpoint:
          held && creditsProtocolServed(protocol.data, held)
            ? creditsEndpointFor(held.endpoints, protocol.data)
            : null,
        models: models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
        })),
      });
    } catch {
      return c.json({ error: 'DorkOS credits models are unavailable.' }, 503);
    }
  });

  router.get('/inference', (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const inference = configManager.get('runtimes').doe.inference;
    // Which format DorkOS picks a model in when nothing is configured: only while
    // credits are in use here, and with no request made.
    const autoProtocol = doeCreditsInUse() ? (peekDoeCreditsPick()?.protocol ?? null) : null;
    if (!inference) return c.json({ inference: null, hasKey: false, autoProtocol });
    const { credentialRef, credentialEndpoint: _endpoint, ...metadata } = inference;
    return c.json({ inference: metadata, hasKey: Boolean(credentialRef), autoProtocol });
  });

  router.put('/inference', (c) => {
    const refused = refuseNonOwner(c);
    if (refused) return refused;
    const parsed = inferenceMetadataSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Check the model, endpoint, and token limits.' }, 400);
    }
    const runtimes = configManager.get('runtimes');
    const previous = runtimes.doe.inference;
    const next: DoeInferenceConfig = parsed.data;
    if (
      next.source === 'api-key' &&
      !next.credentialRef &&
      previous?.source === 'api-key' &&
      new URL(previous.endpoint).href === new URL(next.endpoint).href
    ) {
      next.credentialRef = previous.credentialRef;
      next.credentialEndpoint = previous.credentialEndpoint;
    }
    const updated = { ...runtimes, doe: { ...runtimes.doe, inference: next } };
    configManager.set('runtimes', updated);
    logConfigWrite('the DorkOS model setup', 'runtimes', runtimes, updated);
    return c.json({ ok: true });
  });

  router.post('/credential', async (c) => {
    const refused = refuseNonOwner(c);
    if (refused) return refused;
    const parsed = z
      .object({ inference: DoeInferenceConfigSchema, secret: z.string().min(1) })
      .strict()
      .safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Enter an API key and model settings.' }, 400);
    }
    try {
      await storeDoeCredential(parsed.data.inference, parsed.data.secret);
      return c.json({ ok: true, hasKey: true });
    } catch (error) {
      if (error instanceof ConnectError)
        return c.json({ error: error.message }, error.status as ContentfulStatusCode);
      return c.json({ error: 'Could not save the API key.' }, 500);
    }
  });

  return router;
}
