/**
 * Registers the `dorkos://capabilities` MCP resource against a live `McpServer`
 * instance (spec `capability-registry`, task 2.3). Split out of `mcp-server.ts`
 * alongside the other `dorkos://` resources — see `skill-resources.ts` for the
 * pattern.
 *
 * The resource returns the live self-description catalog: the same
 * {@link CapabilityRegistry.catalog} payload the `list_capabilities` tool and the
 * `GET /api/capabilities/catalog` route serve — every capability with its id,
 * title, description, tier, input/output JSON Schema, and surfaces, plus a
 * content-hash `catalogVersion` an agent can cache on. Exposing it as a resource
 * (not just a tool) lets an MCP client pin it into context without spending a
 * tool call.
 *
 * @module services/core/external-mcp/capabilities-resource
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CapabilityRegistry } from '../capabilities/index.js';
import { jsonResourceContents } from './resource-helpers.js';

/**
 * Register `dorkos://capabilities` against `server`, serving the registry's live
 * catalog.
 *
 * @param server - The external `McpServer` instance to register the resource against.
 * @param registry - The composed capability registry whose catalog is served.
 */
export function registerCapabilitiesResource(
  server: McpServer,
  registry: CapabilityRegistry
): void {
  server.registerResource(
    'capabilities',
    'dorkos://capabilities',
    {
      title: 'Capabilities',
      description:
        'The live catalog of everything you can do in this DorkOS: every registered capability with ' +
        'its id, title, description, permission tier, input/output JSON Schema, and surfaces (MCP tool, ' +
        'CLI verb, HTTP route). Includes a content-hash catalogVersion you can cache on.',
      mimeType: 'application/json',
    },
    async () => jsonResourceContents('dorkos://capabilities', registry.catalog())
  );
}
