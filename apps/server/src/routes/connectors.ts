/**
 * Connector routes (connector-gateway spec §API changes) — the thin REST
 * surface over the {@link ConnectorRegistry} and its providers.
 *
 * - `GET  /api/connectors/toolkits` — aggregated connectable services.
 * - `GET  /api/connectors/recommend?service=<slug>` — routed recommendations.
 * - `POST /api/connectors/:provider/connect` — begin a connect flow.
 * - `GET  /api/connectors/flows/:flowId` — poll a connect flow.
 * - `GET  /api/connectors/accounts?toolkit=<slug>` — aggregated accounts.
 * - `DELETE /api/connectors/accounts/:accountId` — disconnect (idempotent).
 *
 * SECURITY (spec §Security Considerations): the server-only `provider` field is
 * stripped from the accounts DTO, and no `McpAppServerConnection` (stdio
 * command/env or session URL) ever travels to the client — these routes carry
 * only reference-shaped account metadata and connect statuses.
 *
 * The router holds no I/O of its own beyond an in-memory map of in-flight
 * connect flows to their originating provider (a `flowId` is provider-scoped but
 * the spec's poll route is not); every real collaborator is injected, so it is
 * driven with fakes in tests and the real singletons in `index.ts`.
 *
 * @module routes/connectors
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ConnectedAccount, ConnectedAccountId } from '@dorkos/shared/connector-provider';
import { parseBody } from '../lib/route-utils.js';
import { recommendConnector, type RelayAdapterCatalog } from '../services/connectors/routing.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';

/** Constructor dependencies for {@link createConnectorsRouter}. */
export interface ConnectorsRouterDeps {
  /** The registry holding the connector backends + id → provider routing. */
  registry: ConnectorRegistry;
  /** Optional relay adapter catalog for relay-adapter-first routing; absent when relay is off. */
  relay?: RelayAdapterCatalog;
}

/** Body for `POST /:provider/connect`. */
const ConnectRequestSchema = z.object({
  toolkit: z.string().min(1),
  label: z.string().min(1).optional(),
});

/** The session-facing account shape — the server-only `provider` field removed. */
type PublicConnectedAccount = Omit<ConnectedAccount, 'provider'>;

/** Strip the server-only `provider` field before an account crosses to the client. */
function toPublicAccount(account: ConnectedAccount): PublicConnectedAccount {
  const { provider: _provider, ...rest } = account;
  return rest;
}

/**
 * Create the connectors router.
 *
 * @param deps - Injected registry + optional relay catalog; see {@link ConnectorsRouterDeps}.
 * @returns An Express router mounted at `/api/connectors`.
 */
export function createConnectorsRouter(deps: ConnectorsRouterDeps): Router {
  const router = Router();
  const { registry } = deps;

  // Maps an in-flight connect flow id to the provider type that minted it, so
  // the provider-less poll route can route pollConnect back to the right
  // backend. In-memory and process-scoped: an in-flight OAuth flow does not
  // survive a server restart (the user simply re-initiates), which is the same
  // liveness the loopback-PKCE flow already assumes.
  const flowProviders = new Map<string, string>();

  router.get('/toolkits', async (_req, res) => {
    const { toolkits, warnings } = await registry.listToolkits();
    res.json({ toolkits, warnings });
  });

  router.get('/recommend', async (req, res) => {
    const service = typeof req.query.service === 'string' ? req.query.service : undefined;
    if (!service) {
      res.status(400).json({ error: "Missing required 'service' query parameter" });
      return;
    }
    const recommendations = await recommendConnector(service, {
      registry,
      relay: deps.relay,
    });
    res.json({ recommendations });
  });

  router.post('/:provider/connect', async (req, res) => {
    const providerType = req.params.provider;
    const provider = registry.resolveProvider(providerType);
    if (!provider) {
      res.status(404).json({ error: `Unknown connector provider '${providerType}'` });
      return;
    }
    // Express 5: req.body is undefined on an empty POST — default to {} so the
    // schema reports the missing `toolkit` as a validation error, not a crash.
    const body = parseBody(ConnectRequestSchema, req.body ?? {}, res);
    if (!body) return;

    try {
      const start = await provider.startConnect(
        body.toolkit,
        body.label ? { label: body.label } : undefined
      );
      flowProviders.set(start.flowId, providerType);
      res.json(start);
    } catch (err) {
      // A rejected startConnect is a bad request (unknown toolkit, or a second
      // connect on a single-account backend) — surfaced, never a 500.
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'Failed to start connect' });
    }
  });

  router.get('/flows/:flowId', async (req, res) => {
    const flowId = req.params.flowId;
    const providerType = flowProviders.get(flowId);
    const provider = providerType ? registry.resolveProvider(providerType) : undefined;
    if (!provider) {
      res.status(404).json({ error: `Unknown connect flow '${flowId}'` });
      return;
    }
    const poll = await provider.pollConnect(flowId);
    // On success, bind the account id → provider so toolServerForAccount /
    // disconnect can route it later (first-write-wins; re-polling is harmless).
    if (poll.status === 'connected' && poll.account) {
      registry.recordConnect(poll.account);
    }
    res.json(poll);
  });

  router.get('/accounts', async (req, res) => {
    const toolkit = typeof req.query.toolkit === 'string' ? req.query.toolkit : undefined;
    const { accounts, warnings } = await registry.listAccounts(toolkit ? { toolkit } : undefined);
    res.json({ accounts: accounts.map(toPublicAccount), warnings });
  });

  router.delete('/accounts/:accountId', async (req, res) => {
    const accountId = req.params.accountId as ConnectedAccountId;
    const provider = registry.providerForAccount(accountId);
    // Idempotent: disconnect the owning provider if we can route the id, then
    // clear the binding. An unknown/already-removed id still resolves 204.
    if (provider) {
      await provider.disconnect(accountId);
    }
    registry.recordDisconnect(accountId);
    res.status(204).end();
  });

  return router;
}
