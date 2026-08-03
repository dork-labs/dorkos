/**
 * Agent ↔ connector attach/detach routes (connection-scoping spec
 * `specs/connection-scoping/` §Part 1) — the STANDING consent binding between
 * an agent and a connected account, as opposed to `routes/session-connectors.ts`'s
 * per-session binding. Every session belonging to an attached agent inherits
 * the account's tools on its next hydration
 * (`SessionConnectorService.hydrateSession`) unless a session-level override
 * says otherwise (precedence: session > agent, no merge — see
 * `specs/connection-scoping/design-decisions.md` D2).
 *
 * - `POST   /api/agents/:agentId/connectors/:accountId` — attach (the consent
 *   point); re-shows the custody disclosure.
 * - `DELETE /api/agents/:agentId/connectors/:accountId` — detach (idempotent).
 * - `GET    /api/agents/:agentId/connectors` — this agent's standing attachments.
 *
 * Thin, like its session-scoped sibling: no `McpAppServerConnection` detail
 * crosses to the client, and no connection is resolved here at all — an
 * agent-level attach records INTENT only, resolution happens per session at
 * hydration time.
 *
 * @module routes/agent-connectors
 */
import { Router } from 'express';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import type { AgentConnectorAttachmentStore } from '../services/connectors/attachment-store.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';
import { disclosureForAccount } from '../services/connectors/custody-disclosure.js';

/** Minimal mesh lookup the attach route needs to validate an agent exists. */
export interface AgentConnectorsMeshLike {
  getProjectPath(agentId: string): string | undefined;
}

/** Constructor dependencies for {@link createAgentConnectorsRouter}. */
export interface AgentConnectorsRouterDeps {
  /** The standing agent-level attachment store. */
  store: AgentConnectorAttachmentStore;
  /** The registry, used to validate the account id and build the disclosure. */
  registry: ConnectorRegistry;
  /**
   * Mesh lookup to validate `agentId` before attaching (adversarial review
   * MAJOR 7 — mirrors `routes/unclaimed-chats.ts`'s claim route, which needs
   * the identical check for the identical reason: without it, a typo'd
   * agent id silently accumulates standing consent for an agent that will
   * never exist). Optional only so a caller that genuinely has no mesh
   * (some tests) can omit it; the server always wires it.
   */
  meshCore?: AgentConnectorsMeshLike;
}

/**
 * Create the agent-connectors router.
 *
 * @param deps - Injected store + registry + mesh lookup; see {@link AgentConnectorsRouterDeps}.
 * @returns An Express router to mount at `/api/agents`.
 */
export function createAgentConnectorsRouter(deps: AgentConnectorsRouterDeps): Router {
  // mergeParams so the mounted `:agentId` segment is visible to these handlers.
  const router = Router({ mergeParams: true });
  const { store, registry, meshCore } = deps;

  router.get('/:agentId/connectors', (req, res) => {
    res.json({ accounts: store.listForAgent(req.params.agentId) });
  });

  router.post('/:agentId/connectors/:accountId', (req, res) => {
    if (meshCore && !meshCore.getProjectPath(req.params.agentId)) {
      res.status(400).json({ error: `Agent '${req.params.agentId}' not found in mesh registry` });
      return;
    }
    const accountId = req.params.accountId as ConnectedAccountId;
    const binding = registry.accountBinding(accountId);
    if (!binding) {
      res.status(404).json({ error: `Unknown connected account '${accountId}'` });
      return;
    }
    store.attach(req.params.agentId, accountId);
    res.json({
      account: {
        accountId,
        toolkit: binding.toolkit,
        label: binding.label,
        status: binding.status,
      },
      disclosure: disclosureForAccount(binding),
    });
  });

  router.delete('/:agentId/connectors/:accountId', (req, res) => {
    store.detach(req.params.agentId, req.params.accountId as ConnectedAccountId);
    res.status(204).end();
  });

  return router;
}
