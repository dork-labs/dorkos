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
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import type { ConnectorProviderBootstrapper } from '../services/connectors/bootstrap.js';
import type { CredentialStore } from '../services/core/credential-provider.js';
import { migrationHealthGate } from './connector-owner-boundary.js';

/** Constructor dependencies for {@link createConnectorProvidersRoutes}. */
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
 * The 403 for a key change, unless the person who owns this install is
 * asking. A saved key decides which account every connection's calls go out
 * on, so an agent never writes one, and with login on neither does another
 * signed-in account.
 *
 * @returns The refusal, or `undefined` when the caller may change keys.
 */
function keyChangeRefusal(c: Context<ApiEnv>): Response | undefined {
  const refusal = refuseUnlessAccountOwner(honoRequestFacts(c));
  return refusal === undefined ? undefined : c.json(KEY_CHANGE_REFUSAL[refusal], 403);
}

/** Body for `PUT /:provider/credential`. */
const CredentialBodySchema = z.object({ secret: z.string().min(1) });

/**
 * Create the connector-providers routes.
 *
 * @param deps - Injected bootstrapper + credential store; see {@link ConnectorProvidersRouterDeps}.
 * @returns The routes, mounted at `/api/connectors/providers`.
 */
export function createConnectorProvidersRoutes(deps: ConnectorProvidersRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const { bootstrapper, credentialStore } = deps;

  router.use(migrationHealthGate(bootstrapper));

  router.get('/', async (c) => {
    const [providers, appConnections] = await Promise.all([
      bootstrapper.listStatuses(),
      bootstrapper.appConnections(),
    ]);
    return c.json({ providers, appConnections });
  });

  router.put('/:provider/credential', async (c) => {
    const refused = keyChangeRefusal(c);
    if (refused) return refused;
    const provider = c.req.param('provider');
    const credentialName = bootstrapper.credentialNameFor(provider);
    if (!credentialName) {
      return c.json({ error: 'DorkOS doesn’t use a key of this kind. Nothing was saved.' }, 400);
    }
    // An empty PUT has no body — read it as {} so the schema reports the
    // missing `secret` as a validation error, not a crash.
    const parsed = CredentialBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);

    await credentialStore.put(credentialName, parsed.data.secret);
    try {
      return c.json(await bootstrapper.reload(provider));
    } catch {
      // A non-refusal factory error (a genuine bug). Generic on purpose: this
      // path must never echo anything derived from the stored secret.
      logger.error(`[Connectors] Provider reload failed after credential save`, { provider });
      return c.json(
        { error: 'The key was saved, but DorkOS couldn’t start using it. Try again.' },
        500
      );
    }
  });

  router.delete('/:provider/credential', async (c) => {
    const refused = keyChangeRefusal(c);
    if (refused) return refused;
    const provider = c.req.param('provider');
    const credentialName = bootstrapper.credentialNameFor(provider);
    if (!credentialName) {
      return c.json({ error: 'DorkOS doesn’t use a key of this kind. Nothing was removed.' }, 400);
    }
    // Idempotent: the store's delete is safe when the name is absent, and the
    // reload simply reports unconfigured — a missing key still answers 200.
    await credentialStore.delete(credentialName);
    return c.json(await bootstrapper.reload(provider));
  });

  return router;
}
