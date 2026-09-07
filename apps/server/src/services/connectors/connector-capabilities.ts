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

import { defineCapability, type CapabilityDomain } from '../core/capabilities/index.js';
import type { CapabilityDeps } from '../core/capabilities/index.js';
import { recommendConnector, type RelayAdapterCatalog } from './routing.js';
import type { ConnectorRegistry } from './registry.js';

/** The nonprivate connector discovery services available to capability callers. */
export interface ConnectorCapabilityDeps {
  /** Registry holding the configured provider toolkit catalogs. */
  registry: ConnectorRegistry;
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
        'DorkOS app to connect an account or change access.',
      tier: 'observe',
      input: z.object({}),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_list_toolkits',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps) => requireConnectorDeps(deps).registry.listToolkits(),
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
