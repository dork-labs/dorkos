/**
 * Connector provider credential + status routes (connector-completion spec
 * §Detailed Design 1) — the write path that makes the credential-gated
 * providers reachable without a restart.
 *
 * - `GET    /api/connectors/providers` — setup status per provider, plus every
 *   way set up to reach apps and the one new apps use.
 * - `PUT    /api/connectors/providers/:provider/credential` — store the vendor
 *   key (body `{ secret }`), reload the provider live, return the fresh status.
 * - `DELETE /api/connectors/providers/:provider/credential` — remove the key
 *   (idempotent), reload, return the fresh status.
 *
 * Saving or removing a key is the owner's alone: never an agent, and with
 * login on never another signed-in account (DOR-2678). Reading the statuses
 * stays open; they carry no secret.
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
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { parseBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import type { ConnectorProviderBootstrapper } from '../services/connectors/bootstrap.js';
import type { CredentialStore } from '../services/core/credential-provider.js';

/** Constructor dependencies for {@link createConnectorProvidersRouter}. */
export interface ConnectorProvidersRouterDeps {
  /** The provider lifecycle owner — validates types, reloads, reports status. */
  bootstrapper: ConnectorProviderBootstrapper;
  /** The encrypted write-only secret store the vendor keys land in. */
  credentialStore: CredentialStore;
}

/** What a refused key change says, by why it was refused (DOR-2678). */
const KEY_CHANGE_REFUSAL = {
  'not-a-person': {
    code: 'person_only',
    error: 'Only you can change the keys DorkOS uses to reach your apps, from the DorkOS app.',
  },
  'not-the-owner': {
    code: 'owner_only',
    error: 'Only the owner of this DorkOS can change the keys it uses to reach apps.',
  },
} as const;

/**
 * Answer 403 unless the person who owns this install is asking. A saved key
 * decides which account every connection's calls go out on, so an agent never
 * writes one, and with login on neither does another signed-in account.
 *
 * @returns `true` when the request was answered, so the caller must return.
 */
function refusedKeyChange(req: Request, res: Response): boolean {
  const refusal = refuseUnlessAccountOwner(req, res);
  if (refusal === undefined) return false;
  res.status(403).json(KEY_CHANGE_REFUSAL[refusal]);
  return true;
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

  router.use((_req, res, next) => {
    const health = bootstrapper.migrationHealth();
    if (health.status === 'migration_failed') {
      res.status(503).json({ status: health.status, error: health.error });
      return;
    }
    next();
  });

  router.get('/', async (_req, res) => {
    const [providers, appConnections] = await Promise.all([
      bootstrapper.listStatuses(),
      bootstrapper.appConnections(),
    ]);
    res.json({ providers, appConnections });
  });

  router.put('/:provider/credential', async (req, res) => {
    if (refusedKeyChange(req, res)) return;
    const provider = req.params.provider;
    const credentialName = bootstrapper.credentialNameFor(provider);
    if (!credentialName) {
      res.status(400).json({
        error: 'DorkOS doesn’t use a key of this kind. Nothing was saved.',
      });
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
      res.status(500).json({
        error: 'The key was saved, but DorkOS couldn’t start using it. Try again.',
      });
    }
  });

  router.delete('/:provider/credential', async (req, res) => {
    if (refusedKeyChange(req, res)) return;
    const provider = req.params.provider;
    const credentialName = bootstrapper.credentialNameFor(provider);
    if (!credentialName) {
      res.status(400).json({
        error: 'DorkOS doesn’t use a key of this kind. Nothing was removed.',
      });
      return;
    }
    // Idempotent: the store's delete is safe when the name is absent, and the
    // reload simply reports unconfigured — a missing key still answers 200.
    await credentialStore.delete(credentialName);
    res.json(await bootstrapper.reload(provider));
  });

  return router;
}
