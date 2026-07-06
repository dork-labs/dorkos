/**
 * Runtime connect + provisioning routes, mounted at `/api/runtimes`.
 *
 * The forward-looking home for per-runtime connect actions (ADR-0318): opt-in
 * OpenCode provisioning (ADR-0317), the native paste-key + delegated-login
 * endpoints (T1 task 2.3), the OpenRouter Gateway paste-key/OAuth-PKCE/catalog
 * endpoints (task 2.6), and zero-auth Ollama detection (task 2.7). Every action
 * here is host-mutating or secret-bearing, so all endpoints are loopback-only and
 * no endpoint ever echoes or logs a secret.
 *
 * @module routes/runtimes
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { provisionOpenCode } from '../services/runtimes/opencode/provision.js';
import {
  storeRuntimeCredential,
  storeProviderCredential,
  ConnectError,
} from '../services/runtimes/connect/credentials.js';
import {
  delegateRuntimeLogin,
  LOGIN_RUNTIME_TYPES,
} from '../services/runtimes/connect/delegated-login.js';
import {
  buildAuthorizeUrl,
  fetchOpenRouterModels,
  handleOpenRouterCallback,
  openRouterOAuthStore,
  storeOpenRouterKeyReference,
  OpenRouterError,
} from '../services/runtimes/opencode/openrouter.js';
import { detectOllama, pullOllamaModel } from '../services/runtimes/opencode/ollama.js';
import {
  assessOllamaModels,
  resolveCuratedModel,
  DEFAULT_OLLAMA_MODEL_ID,
} from '../services/runtimes/opencode/ollama-catalog.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Whether a request originated from loopback. Mirrors the tunnel passcode
 * endpoint: a genuine localhost request has `hostname` of `localhost`/`127.0.0.1`
 * (`::1`), while a tunnel request carries the public domain and is rejected.
 */
function isLoopbackRequest(req: Request): boolean {
  return req.hostname === 'localhost' || req.hostname === '127.0.0.1' || req.hostname === '::1';
}

/** Reject non-loopback requests with 403; returns `true` when the request was rejected. */
function rejectNonLoopback(req: Request, res: Response): boolean {
  if (isLoopbackRequest(req)) return false;
  res.status(403).json({ error: 'Runtime connect actions are only available locally' });
  return true;
}

/** Write one SSE frame, no-op once the response has ended. */
function sendEvent(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const SecretBodySchema = z.object({ secret: z.string().min(1) });
const OpenRouterKeyBodySchema = z.object({ key: z.string().min(1) });
const ProviderCredentialBodySchema = z.object({
  providerId: z.string().min(1),
  secret: z.string().min(1),
  baseURL: z.string().nullable().optional(),
});
const OllamaPullBodySchema = z.object({ model: z.string().min(1).optional() });

/**
 * POST /api/runtimes/opencode/provision — opt-in, on-demand OpenCode install.
 *
 * Streams install progress as `progress` SSE frames and a terminal `result`
 * frame carrying the {@link provisionOpenCode} outcome. Loopback-only.
 */
router.post('/opencode/provision', async (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ error: 'Runtime provisioning is only available locally' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const result = await provisionOpenCode((progress) => sendEvent(res, 'progress', progress));
    sendEvent(res, 'result', result);
  } catch (err) {
    // provisionOpenCode returns failures rather than throwing; guard defensively.
    logger.error('[Runtimes] OpenCode provisioning failed unexpectedly', err);
    sendEvent(res, 'result', {
      ok: false,
      error: 'Could not install OpenCode. Please try again.',
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// --- OpenRouter (OpenCode Gateway) -----------------------------------------
// Registered before the generic `/:type/*` routes for readability; the path
// shapes never overlap (these are 3+ segments, the generic ones are 2).

/**
 * POST /api/runtimes/opencode/openrouter/key — validate + store an OpenRouter
 * key (paste-key path). Returns only `{ ok }` (+ honest error) — never the key.
 */
router.post('/opencode/openrouter/key', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const parsed = OpenRouterKeyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'An OpenRouter key is required.' });
  }
  try {
    await storeOpenRouterKeyReference(parsed.data.key);
    res.json({ ok: true });
  } catch (err) {
    // Invalid key / unreachable OpenRouter are expected outcomes — return an
    // honest result, not an exception. Never surface the key.
    if (err instanceof OpenRouterError) {
      return res.json({ ok: false, error: err.message });
    }
    logger.error('[Runtimes] OpenRouter key store failed unexpectedly');
    res.status(500).json({ ok: false, error: 'Could not save the OpenRouter key.' });
  }
});

/**
 * POST /api/runtimes/opencode/openrouter/oauth/start — begin OAuth-PKCE. Mints
 * a verifier + state (verifier stays server-side) and returns the authorize URL
 * (with a loopback callback embedding the state) plus the state to poll.
 */
router.post('/opencode/openrouter/oauth/start', (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const { state, challenge } = openRouterOAuthStore.start();
  const callbackUrl = `${req.protocol}://${req.get('host')}/api/runtimes/opencode/openrouter/oauth/callback?state=${state}`;
  res.json({ authorizeUrl: buildAuthorizeUrl(callbackUrl, challenge), state });
});

/**
 * GET /api/runtimes/opencode/openrouter/oauth/callback — the loopback landing the
 * browser is redirected to after authorization. Validates state, exchanges the
 * code for a scoped key, stores it by reference, and renders a plain page telling
 * the user to return to DorkOS. Loopback-only (the user's own browser hits it).
 */
router.get('/opencode/openrouter/oauth/callback', async (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).send('Not available.');
  }
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;
  const result = await handleOpenRouterCallback({ state, code, error });
  res
    .status(result.status === 'connected' ? 200 : 400)
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(renderCallbackPage(result.status === 'connected', result.error));
});

/**
 * GET /api/runtimes/opencode/openrouter/oauth/status — poll an in-flight flow's
 * status by `state` (the client polls after opening the authorize URL).
 */
router.get('/opencode/openrouter/oauth/status', (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  res.json(openRouterOAuthStore.status(state));
});

/**
 * GET /api/runtimes/opencode/openrouter/models — the OpenRouter model catalog for
 * the picker (short-TTL cached server-side).
 */
router.get('/opencode/openrouter/models', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const models = await fetchOpenRouterModels();
  res.json({ models });
});

// --- Ollama (OpenCode Local) -----------------------------------------------

/**
 * GET /api/runtimes/opencode/ollama — zero-auth local Ollama detection: running
 * state + pulled models, bounded so an absent/hung Ollama degrades fast.
 */
router.get('/opencode/ollama', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  res.json(await detectOllama());
});

/**
 * GET /api/runtimes/opencode/ollama/models — the curated coding-model catalog for
 * the guided pull, each entry assessed against this machine's hardware with an
 * honest `runs-well | may-be-slow | too-large` verdict. Static heuristic, not a
 * benchmark; never claims certainty.
 */
router.get('/opencode/ollama/models', (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  res.json(assessOllamaModels());
});

/**
 * POST /api/runtimes/opencode/ollama/pull — trigger a single guided pull of a
 * curated coding model and STREAM download progress (mirrors the provision
 * endpoint's SSE shape: `progress` frames then a terminal `result`). Loopback-only.
 *
 * The model is restricted to the curated catalog — DorkOS guides one pull, it is
 * not an open model browser. An uncurated id is rejected up front (before the
 * stream opens); DorkOS never owns or manages Ollama's library.
 */
router.post('/opencode/ollama/pull', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;

  const parsed = OllamaPullBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid pull request.' });
  }
  const requestedId = parsed.data.model ?? DEFAULT_OLLAMA_MODEL_ID;
  const curated = resolveCuratedModel(requestedId);
  if (!curated) {
    return res.status(400).json({
      error: 'Only curated coding models can be pulled here. Use Ollama directly for others.',
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const result = await pullOllamaModel(curated.id, (progress) =>
      sendEvent(res, 'progress', progress)
    );
    sendEvent(res, 'result', result);
  } catch (err) {
    // pullOllamaModel returns failures rather than throwing; guard defensively.
    logger.error('[Runtimes] Ollama pull failed unexpectedly', err);
    sendEvent(res, 'result', {
      ok: false,
      model: curated.id,
      error: 'Could not pull the model. Please try again.',
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/runtimes/opencode/provider/credential — the OpenCode Direct-provider
 * path: store an OpenAI-compatible provider's key by reference, select it as
 * OpenCode's provider, and record an optional base URL. Persists only the
 * reference; the response never echoes the secret. Loopback-only. (Distinct from
 * the generic `/:type/credential` route, which is keyed by runtime type — this is
 * keyed by an arbitrary provider id.)
 */
router.post('/opencode/provider/credential', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const parsed = ProviderCredentialBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A provider id and API key are required.' });
  }
  try {
    const { ref } = await storeProviderCredential({
      providerId: parsed.data.providerId,
      secret: parsed.data.secret,
      baseURL: parsed.data.baseURL ?? null,
    });
    res.json({ ref });
  } catch (err) {
    if (err instanceof ConnectError) {
      return res.status(err.status).json({ error: err.message });
    }
    // Never include the secret or a raw stack in the response or log.
    logger.error('[Runtimes] Provider credential store failed unexpectedly');
    res.status(500).json({ error: 'Could not save the provider key.' });
  }
});

// --- Generic per-runtime connect (Claude, Codex) ---------------------------

/**
 * POST /api/runtimes/:type/credential — store a runtime's native API key
 * (paste-key path). Persists only the reference; the response never echoes the
 * secret. Loopback-only.
 */
router.post('/:type/credential', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const parsed = SecretBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'An API key is required.' });
  }
  try {
    const { ref } = await storeRuntimeCredential(req.params.type, parsed.data.secret);
    res.json({ ref });
  } catch (err) {
    if (err instanceof ConnectError) {
      return res.status(err.status).json({ error: err.message });
    }
    // Never include the secret or a raw stack in the response or log.
    logger.error('[Runtimes] Credential store failed unexpectedly', {
      type: req.params.type,
    });
    res.status(500).json({ error: 'Could not save the API key.' });
  }
});

/**
 * POST /api/runtimes/:type/login — delegate the vendor CLI login terminal-free
 * and detect completion (bounded). Returns `{ ok, error? }`. Loopback-only.
 */
router.post('/:type/login', async (req, res) => {
  if (rejectNonLoopback(req, res)) return;
  const { type } = req.params;
  if (!(LOGIN_RUNTIME_TYPES as readonly string[]).includes(type)) {
    return res.status(400).json({ ok: false, error: `"${type}" does not support sign-in.` });
  }
  const result = await delegateRuntimeLogin(type);
  res.json(result);
});

/**
 * Escape HTML-special characters so an interpolated value can never inject markup
 * into the callback page. All current callers pass fixed strings, but this keeps
 * the same-origin page safe against reflected XSS if a future value is ever
 * user-derived.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal HTML for the OAuth callback landing (no secret, no external assets). */
function renderCallbackPage(connected: boolean, error?: string): string {
  const title = escapeHtml(connected ? 'Connected to OpenRouter' : 'Sign-in failed');
  const body = escapeHtml(
    connected
      ? 'You can close this tab and return to DorkOS.'
      : (error ?? 'Please return to DorkOS and try again.')
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a;"><h1 style="font-size: 1.25rem;">${title}</h1><p style="color: #555;">${body}</p></body></html>`;
}

export default router;
