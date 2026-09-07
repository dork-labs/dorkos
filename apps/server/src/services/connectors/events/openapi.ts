/** Owner notification HTTP contract projected from the same strict route schemas. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ConnectionEventDefinitionPageSchema,
  ConnectionEventSubscriptionPageSchema,
  ConnectionEventSubscriptionSchema,
  CreateConnectionEventSubscriptionSchema,
  ConfigureConnectionEventSourceSchema,
  ConnectionEventSourceStatusSchema,
  ConnectorAgentEventSubscriptionQuerySchema,
  ConnectorAgentEventSubscriptionPageSchema,
} from '@dorkos/shared/connector-event-schemas';

/** Register the owner-only receive-consent and write-only signing setup routes. */
export function registerConnectorEventOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/connectors/accessible/subscriptions',
    tags: ['Connections'],
    summary: 'List notifications one agent is allowed to receive',
    description:
      'Requires a verified API key and an explicit owned agent. Read-only; operation grants do not imply receive access. No event content or private service references are returned.',
    request: { query: ConnectorAgentEventSubscriptionQuerySchema },
    responses: {
      200: {
        description: 'Current agent-scoped receive grants.',
        content: { 'application/json': { schema: ConnectorAgentEventSubscriptionPageSchema } },
      },
      400: { description: 'An agent or cursor is invalid.' },
      401: { description: 'The API key is missing or no longer active.' },
      403: { description: 'Agent runtime credentials cannot act as a program API key.' },
      404: { description: 'The agent is not owned by this API key user.' },
    },
  });
  const prefix = '/api/connectors/connections/{connectionId}/events';
  const params = z.object({ connectionId: z.string().min(1) });
  const query = z.object({ cursor: z.string().max(512).optional() });
  const error = { description: 'Notifications are unavailable or the owner decision changed.' };
  for (const [path, schema, summary] of [
    [
      'definitions',
      ConnectionEventDefinitionPageSchema,
      'List notification types for an owned connection',
    ],
    [
      'subscriptions',
      ConnectionEventSubscriptionPageSchema,
      'List exact notification destinations and consent state',
    ],
    [
      'source',
      ConnectionEventSourceStatusSchema,
      'Read notification setup mode without credential material',
    ],
  ] as const)
    registry.registerPath({
      method: 'get',
      path: `${prefix}/${path}`,
      tags: ['Connections'],
      summary,
      description:
        'Owner-only. Setup mode and configured state do not imply that event delivery is ready.',
      request: { params, ...(path === 'source' ? {} : { query }) },
      responses: {
        200: {
          description: 'Current owner-scoped notification metadata.',
          content: { 'application/json': { schema } },
        },
        403: error,
        404: error,
        503: error,
      },
    });
  registry.registerPath({
    method: 'post',
    path: `${prefix}/subscriptions`,
    tags: ['Connections'],
    summary: 'Approve an exact notification destination',
    description:
      'The requestId identifies one immutable explicit owner decision. Changing its scope conflicts; revocation cannot be undone by replay.',
    request: {
      params,
      body: {
        required: true,
        content: { 'application/json': { schema: CreateConnectionEventSubscriptionSchema } },
      },
    },
    responses: {
      201: {
        description: 'The exact receive consent is active.',
        content: { 'application/json': { schema: ConnectionEventSubscriptionSchema } },
      },
      202: {
        description: 'Consent is recorded; remote acknowledgement is pending.',
        content: { 'application/json': { schema: ConnectionEventSubscriptionSchema } },
      },
      403: error,
      404: error,
      409: error,
      503: error,
    },
  });
  registry.registerPath({
    method: 'delete',
    path: `${prefix}/subscriptions/{subscriptionId}`,
    tags: ['Connections'],
    summary: 'Permanently revoke this notification generation',
    request: { params: params.extend({ subscriptionId: z.string().min(1) }) },
    responses: {
      204: {
        description: 'Local receive authority is closed; upstream cleanup may still be pending.',
      },
      403: error,
      404: error,
      503: error,
    },
  });
  registry.registerPath({
    method: 'put',
    path: `${prefix}/source`,
    tags: ['Connections'],
    summary: 'Configure a write-only webhook signing secret',
    description:
      'Available only when setupMode is byo_webhook. The secret never appears in a response. Payload encryption uses a separately managed key.',
    request: {
      params,
      body: {
        required: true,
        content: { 'application/json': { schema: ConfigureConnectionEventSourceSchema } },
      },
    },
    responses: {
      200: {
        description: 'Local signing setup was saved; this does not prove event delivery.',
        content: { 'application/json': { schema: ConnectionEventSourceStatusSchema } },
      },
      400: error,
      403: error,
      404: error,
      503: error,
    },
  });
}
