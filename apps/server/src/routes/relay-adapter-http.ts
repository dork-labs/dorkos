/**
 * The HTTP edges the adapter routes share: how an adapter refusal is answered,
 * and who the secret rules treat as having written a config (DOR-3271).
 *
 * Split from {@link module:routes/relay-adapters} to keep that file under its
 * line ceiling.
 *
 * @module routes/relay-adapter-http
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody } from '../http/request-body.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import type { SecretWriter } from '../services/relay/adapter-secret-policy.js';

/** Map adapter error codes to HTTP status codes. */
const ADAPTER_ERROR_STATUS: Record<string, number> = {
  DUPLICATE_ID: 409,
  UNKNOWN_TYPE: 400,
  MULTI_INSTANCE_DENIED: 400,
  NOT_FOUND: 404,
  REMOVE_BUILTIN_DENIED: 400,
  // A config its schema refuses — a webhook aimed at a DorkOS address among
  // them (DOR-2432). The caller's mistake, so a 400 that says which rule.
  INVALID_CONFIG: 400,
  // What the owner confirmed no longer matches the connection (DOR-3271).
  CONFIRMATION_STALE: 409,
};

/**
 * Answer an AdapterError, mapping its code to an HTTP status via ADAPTER_ERROR_STATUS.
 *
 * @param c - The Hono context
 * @param err - The AdapterError to answer
 */
export function sendAdapterError(c: Context<ApiEnv>, err: AdapterError): Response {
  const status = (ADAPTER_ERROR_STATUS[err.code] ?? 500) as ContentfulStatusCode;
  return c.json({ error: err.message, code: err.code }, status);
}

/**
 * Who is writing an adapter's settings, for the secret rules (DOR-3271): a
 * person only when the caller clears the agent bar, the same bar that keeps
 * credentials operator-only in `routes/config.ts`.
 */
export function secretWriter(c: Context<ApiEnv>): SecretWriter {
  return clearsTheAgentBar(honoRequestFacts(c)) ? 'person' : 'agent';
}

/** What an agent is told when it asks to confirm a connection's settings. */
const PERSON_ONLY_CONFIRM = 'Only a person can confirm this setting.';

/**
 * `POST /adapters/:id/confirm-references` with `{ fingerprint }`: the owner
 * confirms a connection paused for `env:`/`keychain:` references nobody
 * recorded a person saving (DOR-3271). It approves exactly the summary the
 * owner was shown, so a connection that changed since answers 409.
 * `DELETE` on the same path is the toast's Undo: it takes the approval back
 * and pauses the connection again. Both write the record that decides what a
 * connection may send, so both admit only a caller that clears the agent bar;
 * anything else gets a 403.
 *
 * @param router - The adapter routes' router.
 * @param adapterManager - The adapter manager.
 */
export function registerConfirmReferencesRoute(
  router: Hono<ApiEnv>,
  adapterManager: AdapterManager
): void {
  const handle = async (c: Context<ApiEnv>, undo: boolean) => {
    if (secretWriter(c) !== 'person') {
      return c.json({ error: PERSON_ONLY_CONFIRM, code: 'person_only' }, 403);
    }
    const body = undo ? undefined : (readJsonBody(c) as { fingerprint?: unknown } | undefined);
    if (!undo && typeof body?.fingerprint !== 'string') {
      return c.json({ error: 'Missing what you confirmed.', code: 'INVALID_CONFIG' }, 400);
    }
    try {
      const fingerprint = undo ? null : (body?.fingerprint as string);
      await adapterManager.confirmReferences(c.req.param('id') ?? '', fingerprint, undo);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AdapterError) return sendAdapterError(c, err);
      return c.json({ error: err instanceof Error ? err.message : 'Confirm failed' }, 500);
    }
  };
  router.post('/adapters/:id/confirm-references', (c) => handle(c, false));
  router.delete('/adapters/:id/confirm-references', (c) => handle(c, true));
}
