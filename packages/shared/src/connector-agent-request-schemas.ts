/** Durable agent service-request decisions that may include exact event receive scopes. */
import { z } from 'zod';
import { ConnectorReceiveScopeSchema } from './connector-event-schemas.js';
import { ConnectorProviderInstanceIdSchema } from './connector-provider.js';
import { ConnectionIdSchema, CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT } from './connector-schemas.js';

/** Owner input for authentication started in the context of one agent request. */
export const ConnectorAgentRequestAuthenticationInputSchema = z
  .object({
    providerInstanceId: ConnectorProviderInstanceIdSchema,
    label: z.string().min(1).max(200).optional(),
  })
  .strict();
/** Owner input for authentication started in the context of one agent request. */
export type ConnectorAgentRequestAuthenticationInput = z.infer<
  typeof ConnectorAgentRequestAuthenticationInputSchema
>;

/** Explicit owner decision for one agent request. */
export const ConnectorAgentRequestDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('denied') }).strict(),
  z
    .object({
      decision: z.literal('approved'),
      connectionId: ConnectionIdSchema,
      operationRevisionIds: z.array(z.string().min(1)).min(1).max(200),
      eventScopes: z
        .array(ConnectorReceiveScopeSchema)
        .max(CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT)
        .default([]),
    })
    .strict(),
]);
/** Explicit owner decision for one agent request. */
export type ConnectorAgentRequestDecision = z.infer<typeof ConnectorAgentRequestDecisionSchema>;
