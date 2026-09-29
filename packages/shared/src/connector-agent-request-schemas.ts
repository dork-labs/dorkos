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

/**
 * Explicit owner decision for one agent request. There is one way to answer
 * a request, the same card in a chat and on the Connections page:
 *
 * - `denied` answers no and grants nothing.
 * - `current_access` writes no action access. It answers the request with the
 *   access the agent ALREADY holds on one account, which the owner has just
 *   given it through the shared "who can use it" card. That card only ever
 *   raises one agent's access, so answering this way can never lower access
 *   or touch another agent. The server refuses it when the agent holds
 *   nothing live on that account. `eventScopes` are the exact updates the
 *   owner chose for a request that also asked to hear about new activity.
 */
export const ConnectorAgentRequestDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('denied') }).strict(),
  z
    .object({
      decision: z.literal('current_access'),
      connectionId: ConnectionIdSchema,
      eventScopes: z
        .array(ConnectorReceiveScopeSchema)
        .max(CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT)
        .default([]),
    })
    .strict(),
]);
/** Explicit owner decision for one agent request. */
export type ConnectorAgentRequestDecision = z.infer<typeof ConnectorAgentRequestDecisionSchema>;
/** Owner decision as a caller sends it, before defaults such as `eventScopes: []` are applied. */
export type ConnectorAgentRequestDecisionInput = z.input<
  typeof ConnectorAgentRequestDecisionSchema
>;
