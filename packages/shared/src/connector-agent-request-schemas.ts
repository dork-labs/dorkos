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
 * Explicit owner decision for one agent request.
 *
 * - `denied` answers no and grants nothing.
 * - `approved` writes exactly the chosen operation revisions (a subset of what
 *   the agent asked for) as the agent's access to one account, replacing what
 *   it held there. The Connections page's exact-action review sends it.
 * - `current_access` writes nothing. It answers the request with the access
 *   the agent ALREADY holds on one account, which the owner has just given it
 *   through the shared "who can use it" card (the chat card sends it). That
 *   card only ever raises one agent's access, so answering this way can never
 *   lower access or touch another agent. The server refuses it when the agent
 *   holds nothing live on that account.
 */
export const ConnectorAgentRequestDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('denied') }).strict(),
  z.object({ decision: z.literal('current_access'), connectionId: ConnectionIdSchema }).strict(),
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
