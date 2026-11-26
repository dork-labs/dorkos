/**
 * OpenAPI entries for leaving one agent out of a connection's every-agent
 * share (DOR-3961), and for the per-app writes-back switch (DOR-4794), projected from the
 * schemas the routes answer with.
 *
 * @module services/connectors/access/exclusions-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ConnectorAccessChangeListQuerySchema,
  ConnectorAccessChangeListSchema,
  ConnectorAccessChangeSchema,
  ConnectorAccessChangeUndoSchema,
  ConnectorGrantExclusionChangeSchema,
  ConnectorGrantExclusionListSchema,
  ConnectorGrantExclusionParamsSchema,
  ConnectorWritesBackChangeRequestSchema,
  ConnectorWritesBackChangeSchema,
  ConnectorWritesBackSchema,
} from '@dorkos/shared/connector-exclusion-schemas';
import { INTERNAL_ERROR_RESPONSE, problemResponse } from '../../core/openapi/problem-openapi.js';

const notFound = problemResponse(
  '`not_found`: no such app account here, it belongs to someone else, or no such agent'
);

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
    method: 'get',
    path: '/api/connectors/access-changes',
    tags: ['Connectors'],
    summary: 'Access changes agents made on your apps',
    description:
      "Owner only. Newest first, with each agent's own one-line reason. Show the reason as plain " +
      "text, attributed to the agent: it is the agent's words, not DorkOS's.",
    request: { query: ConnectorAccessChangeListQuerySchema },
    responses: {
      500: INTERNAL_ERROR_RESPONSE,
      200: {
        description: 'The changes',
        content: { 'application/json': { schema: ConnectorAccessChangeListSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/connectors/access-changes/{changeId}',
    tags: ['Connectors'],
    summary: "One access change, with the agent's reason",
    description:
      'Owner only. What a Needs-you item shows. Show the reason as plain text, attributed to the agent.',
    request: { params: z.object({ changeId: z.string().min(1) }) },
    responses: {
      200: {
        description: 'The change',
        content: { 'application/json': { schema: ConnectorAccessChangeSchema } },
      },
      404: problemResponse('`not_found`: no such change on your apps'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/connectors/access-changes/{changeId}/undo',
    tags: ['Connectors'],
    summary: "Undo an agent's change to an agent's access",
    description:
      'Owner only. Puts back the access the change took away, including letting an agent back ' +
      'into a share. Refused when access changed since, so a later choice is never overwritten.',
    request: { params: z.object({ changeId: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Put back',
        content: { 'application/json': { schema: ConnectorAccessChangeUndoSchema } },
      },
      404: problemResponse('`not_found`: nothing to undo under that id'),
      412: problemResponse('`precondition_failed`: access changed since'),
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
  registry.registerPath({
    method: 'get',
    path: '/api/connectors/connections/{connectionId}/writes-back',
    tags: ['Connectors'],
    summary: 'Whether agents may write back to an app they only read',
    description:
      'Owner only. On: an agent whose turn read only this app may make a change back in it ' +
      'without asking. Deletions, sends and changes in any other app still ask.',
    request: { params: z.object({ connectionId: z.string().min(1) }) },
    responses: {
      200: {
        description: 'The switch, and when the person confirmed it',
        content: { 'application/json': { schema: ConnectorWritesBackSchema } },
      },
      404: notFound,
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/connectors/connections/{connectionId}/writes-back',
    tags: ['Connectors'],
    summary: 'Let agents write back to an app they only read, or stop it',
    description:
      'Owner only; no agent or program can set it. Turning it on needs `confirmsNoOutsideSync`: ' +
      'DorkOS cannot see whether the app copies what it holds to another place on its own, so ' +
      'the person confirms it does not, and the time is kept. Turning it off answers at once.',
    request: {
      params: z.object({ connectionId: z.string().min(1) }),
      body: { content: { 'application/json': { schema: ConnectorWritesBackChangeRequestSchema } } },
    },
    responses: {
      200: {
        description: 'What the change did',
        content: { 'application/json': { schema: ConnectorWritesBackChangeSchema } },
      },
      422: problemResponse(
        '`app_not_supported`: the switch is not offered for this app, because its changes can reach other people'
      ),
      400: problemResponse('The body is invalid, or turns it on without the confirmation'),
      404: problemResponse('`not_found`: no such app account here, or it belongs to someone else'),
    },
  });
}
