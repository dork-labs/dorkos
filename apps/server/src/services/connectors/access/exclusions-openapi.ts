/**
 * OpenAPI entries for leaving one agent out of a connection's every-agent
 * share (DOR-3961), projected from the schemas the routes answer with.
 *
 * @module services/connectors/access/exclusions-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ConnectorGrantExclusionChangeSchema,
  ConnectorGrantExclusionListSchema,
  ConnectorGrantExclusionParamsSchema,
} from '@dorkos/shared/connector-exclusion-schemas';

const ErrorSchema = z.object({ error: z.string(), code: z.string() });

const notFound = {
  description:
    'No such app account here, or it belongs to someone else (`connection_not_found`), or no such agent (`agent_not_found`)',
  content: { 'application/json': { schema: ErrorSchema } },
};

/**
 * Register the exclusion routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerConnectorExclusionsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/connectors/connections/{connectionId}/exclusions',
    tags: ['Connectors'],
    summary: "Agents left out of a connection's every-agent share",
    description: 'Owner only. Lists the agents the every-agent share does not reach.',
    request: { params: z.object({ connectionId: z.string().min(1) }) },
    responses: {
      200: {
        description: 'The agents left out, oldest first',
        content: { 'application/json': { schema: ConnectorGrantExclusionListSchema } },
      },
      404: notFound,
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/connectors/connections/{connectionId}/exclusions/{agentId}',
    tags: ['Connectors'],
    summary: "Leave one agent out of a connection's every-agent share",
    description:
      'Owner only. The agent keeps only the access given to it by name. The share, now and ' +
      'as it changes later, no longer reaches it. Takes effect on its next call.',
    request: { params: ConnectorGrantExclusionParamsSchema },
    responses: {
      200: {
        description: 'The agent is left out',
        content: { 'application/json': { schema: ConnectorGrantExclusionChangeSchema } },
      },
      404: notFound,
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/api/connectors/connections/{connectionId}/exclusions/{agentId}',
    tags: ['Connectors'],
    summary: "Let one agent back into a connection's every-agent share",
    description:
      'Owner only. The agent gets whatever the share gives every agent now. Only a person can do this.',
    request: { params: ConnectorGrantExclusionParamsSchema },
    responses: {
      200: {
        description: 'The agent is no longer left out',
        content: { 'application/json': { schema: ConnectorGrantExclusionChangeSchema } },
      },
      404: notFound,
    },
  });
}
