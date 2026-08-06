/**
 * Registers the `dorkos://capabilities` MCP resource against a live `McpServer`
 * instance (spec `capability-registry`, task 2.3): the external `/mcp` server
 * and the in-session `dorkos` tool server alike (see `index.ts` in this
 * directory).
 *
 * The resource returns the live self-description catalog: the FULL
 * {@link CapabilityRegistry.catalog} payload — every capability with its id,
 * title, description, tier, input/output JSON Schema, and surfaces, plus a
 * content-hash `catalogVersion` an agent can cache on. The `list_capabilities`
 * tool and the `GET /api/capabilities/catalog` route now PROJECT that catalog
 * (filter, paginate, compact-by-default; DOR-940) so a discovery call cannot
 * flood an agent's context; the resource deliberately pins the whole thing, which
 * is what a resource is for — an MCP client pins it into context once without
 * spending a tool call.
 *
 * @module services/core/mcp-resources/capabilities-resource
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CapabilityRegistry } from '../capabilities/index.js';
import { jsonResourceContents } from './resource-helpers.js';

/**
 * Register `dorkos://capabilities` against `server`, serving the registry's live
 * catalog.
 *
 * @param server - The `McpServer` instance to register the resource against.
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
        'The live catalog of the DorkOS capabilities you can invoke by id: each one with its id, ' +
        'title, description, permission tier, input/output JSON Schema, and surfaces (MCP tool, CLI ' +
        'verb, HTTP route). Includes a content-hash catalogVersion you can cache on. This is NOT the ' +
        'full list of DorkOS tools: the task, relay, mesh, binding, extension, and UI tools are ' +
        'registered directly on the MCP server, so they do not appear here and cannot be reached ' +
        'by `dorkos call`. They carry a permission tier all the same and answer to the same ' +
        'approval gate, so a tool being absent here is not a tool that runs unasked: ' +
        '`tasks_delete` and `mesh_unregister` are destructive and stop for a person.',
      mimeType: 'application/json',
    },
    async () => jsonResourceContents('dorkos://capabilities', registry.catalog())
  );
}
