/** Owner-only, loopback DorkOS model setup; metadata reads never resolve secrets. */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DoeInferenceConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import { isLocalCaller, refuseUnlessAccountOwner } from '../../../lib/caller-authority.js';
import { creditsModelsFor } from '../../core/cloud/credits-models.js';
import { heldCreditsToken } from '../../core/cloud/credits-inference.js';
import { creditsEndpointFor, creditsProtocolServed } from '../../core/cloud/credits-protocols.js';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { storeDoeCredential } from './doe-credentials.js';
import { ConnectError } from './connect-error.js';
const router = Router();
// Preserve the persisted schema's validations while keeping key references server-owned.
const inferenceMetadataSchema = DoeInferenceConfigSchema.safeExtend({
  credentialRef: z.never().optional(),
  credentialEndpoint: z.never().optional(),
});
function rejectNonLoopback(req: Request, res: Response): boolean {
  if (isLocalCaller(req)) return false;
  res.status(403).json({ error: 'Model setup is only available on this computer.' });
  return true;
}
/** Credential and billing choices require the local owner, not merely a loopback socket. */
function rejectNonOwner(req: Request, res: Response): boolean {
  if (rejectNonLoopback(req, res)) return true;
  const refusal = refuseUnlessAccountOwner(req, res);
  if (!refusal) return false;
  res.status(403).json({ error: 'Only the owner can change model settings.', code: refusal });
  return true;
}
// Explicit DorkOS setup uses encrypted endpoint-bound keys, never a vendor login.
router.get('/credits-models', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const protocol = z
    .enum(['anthropic-messages', 'openai-chat-completions', 'openai-responses'])
    .safeParse(req.query.protocol);
  if (!protocol.success) {
    res.status(400).json({ error: 'Choose a model protocol.' });
    return;
  }
  try {
    const models = await creditsModelsFor(protocol.data);
    const held = heldCreditsToken();
    res.json({
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
    res.status(503).json({ error: 'DorkOS credits models are unavailable.' });
  }
});

router.get('/inference', (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const inference = configManager.get('runtimes').doe.inference;
  if (!inference) return res.json({ inference: null, hasKey: false });
  const { credentialRef, credentialEndpoint: _endpoint, ...metadata } = inference;
  return res.json({ inference: metadata, hasKey: Boolean(credentialRef) });
});

router.put('/inference', (req, res) => {
  if (rejectNonOwner(req, res)) return;
  const parsed = inferenceMetadataSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'Check the model, endpoint, and token limits.' });
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
  return res.json({ ok: true });
});

router.post('/credential', async (req, res) => {
  if (rejectNonOwner(req, res)) return;
  const parsed = z
    .object({ inference: DoeInferenceConfigSchema, secret: z.string().min(1) })
    .strict()
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'Enter an API key and model settings.' });
  try {
    await storeDoeCredential(parsed.data.inference, parsed.data.secret);
    return res.json({ ok: true, hasKey: true });
  } catch (error) {
    if (error instanceof ConnectError)
      return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: 'Could not save the API key.' });
  }
});

export default router;
