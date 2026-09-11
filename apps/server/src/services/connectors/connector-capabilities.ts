/**
 * Provider-neutral connector discovery capabilities.
 *
 * Private accounts, connection flows, and attachment mutations are deliberately
 * absent. Agents execute only through the authenticated internal connector MCP
 * server, whose capabilities recheck exact canonical grants for every call.
 *
 * @module services/connectors/connector-capabilities
 */
import { z } from 'zod';
import type { ConnectorCatalogResourcePage } from '@dorkos/shared/connector-resource-schemas';

import { defineCapability, type CapabilityDomain } from '../core/capabilities/index.js';
import type { CapabilityDeps } from '../core/capabilities/index.js';
import { recommendConnector, type RelayAdapterCatalog } from './routing.js';
import type { ConnectorRegistry } from './registry.js';

/** The nonprivate connector discovery services available to capability callers. */
export interface ConnectorCapabilityDeps {
  /** Registry holding the configured provider toolkit catalogs. */
  registry: ConnectorRegistry;
  /** Account-free catalog projection; never exposes authentication setup or account inventory. */
  catalog: (input: {
    query?: string;
    cursor?: string;
    limit?: number;
    signal: AbortSignal;
  }) => Promise<ConnectorCatalogResourcePage>;
  /** Optional relay adapter catalog for relay-adapter-first recommendations. */
  relay?: RelayAdapterCatalog;
}

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Nonprivate connector discovery services. */
    connectorDeps?: ConnectorCapabilityDeps;
  }
}

/** Resolve the connector discovery bundle and enforce subsystem health. */
function requireConnectorDeps(deps: CapabilityDeps): ConnectorCapabilityDeps {
  if (!deps.connectorDeps) {
    throw new Error('Connector capability invoked without connectorDeps in the registry bag.');
  }
  deps.connectorDeps.registry.assertAvailable();
  return deps.connectorDeps;
}

/** Validate connector dependency wiring without touching migration health at boot. */
function assertConnectorDeps(deps: CapabilityDeps): void {
  if (!deps.connectorDeps) {
    throw new Error('Connector capability invoked without connectorDeps in the registry bag.');
  }
}

/** Nonprivate provider-neutral discovery projected onto ordinary MCP surfaces. */
export const connectorDomain: CapabilityDomain = {
  name: 'connector',
  assertDeps: assertConnectorDeps,
  capabilities: [
    defineCapability({
      id: 'connector.list_toolkits',
      title: 'List connectable services',
      description:
        'List services you can use with DorkOS. Open Connections in the ' +
        'DorkOS app to connect an account or change access. Follow nextCursor with the ' +
        'same query to see more services; warnings mean the catalog is incomplete.',
      tier: 'observe',
      input: z
        .object({
          query: z.string().trim().max(200).optional(),
          cursor: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_list_toolkits',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input, context) => {
        const page = await requireConnectorDeps(deps).catalog({
          ...input,
          signal: context.signal ?? AbortSignal.timeout(30_000),
        });
        return {
          ...page,
          // Keep the original toolkit fields for callers that predate pagination.
          // Messaging-only entries remain in services, without inventing account support.
          toolkits: page.services.flatMap((service) => {
            const account = service.intents.find((intent) => intent.kind === 'account');
            const route = account?.routes[0];
            return route
              ? [
                  {
                    slug: service.serviceSlug,
                    displayName: service.displayName,
                    authKind: route.authKind,
                  },
                ]
              : [];
          }),
          warnings: page.warnings.map((warning) => ({ ...warning, provider: 'catalog' })),
        };
      },
    }),
    defineCapability({
      id: 'connector.recommend',
      title: 'Recommend how to connect a service',
      description:
        'Recommend the best route for a service. Account setup and access changes ' +
        'remain owner actions in the DorkOS app.',
      tier: 'observe',
      input: z.object({
        service: z.string().min(1).describe("Service slug, for example 'gmail' or 'slack'."),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_recommend',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) => {
        const { registry, relay } = requireConnectorDeps(deps);
        return recommendConnector(input.service, { registry, ...(relay && { relay }) });
      },
    }),
  ],
};
