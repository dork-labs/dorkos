/**
 * Connector provider credential + status routes (connector-completion spec
 * §Detailed Design 1) — the write path that makes the credential-gated
 * providers reachable without a restart.
 *
 * - `GET    /api/connectors/providers` — setup status per provider.
 * - `PUT    /api/connectors/providers/:provider/credential` — store the vendor
 *   key (body `{ secret }`), reload the provider live, return the fresh status.
 * - `DELETE /api/connectors/providers/:provider/credential` — remove the key
 *   (idempotent), reload, return the fresh status.
 *
 * SECURITY: mirrors `storeRuntimeCredential` (`services/runtimes/connect/
 * credentials.ts`, DOR-280): the secret goes straight into the encrypted
 * {@link CredentialStore} and only reference-free status DTOs come back — the
 * secret never appears in any response, log line, or error message. Provider
 * validity is decided by the injected bootstrapper (`credentialNameFor`), so
 * `test-connector` is accepted exactly when its test-mode spec exists.
 *
 * @module routes/connector-providers
 */
import { Router } from 'express';
import { z } from 'zod';
import { parseBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import type { ConnectorProviderBootstrapper } from '../services/connectors/bootstrap.js';
import type { CredentialStore } from '../services/core/credential-provider.js';

/** Constructor dependencies for {@link createConnectorProvidersRouter}. */
export interface ConnectorProvidersRouterDeps {
  /** The provider lifecycle owner — validates types, reloads, reports status. */
  bootstrapper: ConnectorProviderBootstrapper;
  /** The encrypted write-only secret store the vendor keys land in. */
  credentialStore: CredentialStore;
}

/** Body for `PUT /:provider/credential`. */
const CredentialBodySchema = z.object({ secret: z.string().min(1) });

/**
 * Create the connector-providers router.
 *
 * @param deps - Injected bootstrapper + credential store; see {@link ConnectorProvidersRouterDeps}.
 * @returns An Express router mounted at `/api/connectors/providers`.
 */
export function createConnectorProvidersRouter(deps: ConnectorProvidersRouterDeps): Router {
  const router = Router();
  const { bootstrapper, credentialStore } = deps;

  router.get('/', async (_req, res) => {
    res.json({ providers: await bootstrapper.listStatuses() });
  });

  router.put('/:provider/credential', async (req, res) => {
    const provider = req.params.provider;
    const credentialName = bootstrapper.credentialNameFor(provider);
    if (!credentialName) {
      res.status(400).json({ error: `Unknown connector provider '${provider}'` });
      return;
    }
    // Express 5: req.body is undefined on an empty PUT — default to {} so the
    // schema reports the missing `secret` as a validation error, not a crash.
    const body = parseBody(CredentialBodySchema, req.body ?? {}, res);
    if (!body) return;

    await credentialStore.put(credentialName, body.secret);
    try {
      res.json(await bootstrapper.reload(provider));
    } catch {
      // A non-refusal factory error (a genuine bug). Generic on purpose: this
      // path must never echo anything derived from the stored secret.
      logger.error(`[Connectors] Provider reload failed after credential save`, { provider });
      res.status(500).json({ error: 'The key was saved, but the provider failed to start.' });
    }
  });

  router.delete('/:provider/credential', async (req, res) => {
    const provider = req.params.provider;
    const credentialName = bootstrapper.credentialNameFor(provider);
    if (!credentialName) {
      res.status(400).json({ error: `Unknown connector provider '${provider}'` });
      return;
    }
    // Idempotent: the store's delete is safe when the name is absent, and the
    // reload simply reports unconfigured — a missing key still answers 200.
    await credentialStore.delete(credentialName);
    res.json(await bootstrapper.reload(provider));
  });

  return router;
}
