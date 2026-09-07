/** Bounded event discovery, consent and delivery contracts for connector providers. */
import { z } from 'zod';
import { ConnectionIdSchema } from './connector-schemas.js';

/** Maximum verified event age at which either managed or local delivery may begin. */
export const CONNECTOR_EVENT_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
/** Payload-free dedupe metadata outlives delivery expiry and signature acceptance. */
export const CONNECTOR_EVENT_METADATA_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
/** Fixed webhook acceptance window; never controlled by an ingress caller. */
export const CONNECTOR_EVENT_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Maximum raw signed request size before provider verification. */
export const CONNECTOR_EVENT_MAX_RAW_BYTES = 256 * 1_024;
/** Maximum normalized plaintext size before protection. */
export const CONNECTOR_EVENT_MAX_PAYLOAD_BYTES = 64 * 1_024;
/** Bounded row count for opportunistic retention and delivery work. */
export const CONNECTOR_EVENT_BATCH_LIMIT = 100;

/** Actual upstream detection mode; an absent provider field means unknown. */
export const ConnectorEventDeliveryModeSchema = z.enum(['webhook', 'polling', 'unknown']);
/** Immutable event definition presented for explicit receive consent. */
export const ConnectorEventDefinitionSchema = z
  .object({
    eventType: z.string().min(1).max(256),
    displayName: z.string().min(1).max(512),
    toolkit: z.string().min(1).max(128),
    toolkitVersion: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value !== 'latest'),
    definitionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    filterSchema: z.record(z.string(), z.unknown()),
    payloadSchema: z.record(z.string(), z.unknown()),
    deliveryMode: ConnectorEventDeliveryModeSchema,
    expectedCadenceSeconds: z.number().int().positive().nullable(),
  })
  .strict();
/** Immutable event definition. */
export type ConnectorEventDefinition = z.infer<typeof ConnectorEventDefinitionSchema>;

/** Exact destination selected by an owner; missing destinations are never retargeted. */
export const ConnectorEventDestinationSchema = z
  .object({
    kind: z.enum(['agent', 'room', 'channel']),
    id: z.string().min(1).max(256),
  })
  .strict();
/** Exact event destination. */
export type ConnectorEventDestination = z.infer<typeof ConnectorEventDestinationSchema>;

/** Public proposal; private account, trigger and tenant references are forbidden. */
export const ConnectorReceiveScopeSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    definitionId: z.string().min(1).max(256),
    filter: z.record(z.string(), z.unknown()),
    agentId: z.string().min(1).max(256),
    destination: ConnectorEventDestinationSchema,
  })
  .strict();
/** Explicit event reception proposal, independent of operation grants. */
export type ConnectorReceiveScope = z.infer<typeof ConnectorReceiveScopeSchema>;

/** Supported normalized content, encrypted at rest and treated as untrusted text. */
export const ConnectorEventContentSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(512),
    text: z.string().max(48_000),
  })
  .strict();
/** Supported event content resolved in memory at the destination boundary. */
export type ConnectorEventContent = z.infer<typeof ConnectorEventContentSchema>;

/** Exact instance-to-hosted request for a bounded event lease batch. */
export const ManagedConnectorEventPullRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(CONNECTOR_EVENT_BATCH_LIMIT).default(50),
  })
  .strict();
/** Authorized event handoff; content is transferred only over the authenticated server boundary. */
export const ManagedConnectorEventDeliverySchema = z
  .object({
    id: z.string().uuid(),
    subscriptionId: z.string().min(1).max(256),
    subscriptionVersion: z.number().int().positive(),
    providerEventId: z.string().min(1).max(256),
    leaseToken: z.string().uuid(),
    receivedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    content: ConnectorEventContentSchema,
  })
  .strict();
/** Protected managed handoff projection. */
export type ManagedConnectorEventDelivery = z.infer<typeof ManagedConnectorEventDeliverySchema>;
/** Bounded hosted response, never a caller-controlled pagination or dedupe identity. */
export const ManagedConnectorEventPullResponseSchema = z
  .object({
    events: z.array(ManagedConnectorEventDeliverySchema).max(CONNECTOR_EVENT_BATCH_LIMIT),
  })
  .strict();
/** Acknowledge only exact rows leased to this authenticated instance key. */
export const ManagedConnectorEventAckRequestSchema = z
  .object({
    events: z
      .array(z.object({ id: z.string().uuid(), leaseToken: z.string().uuid() }).strict())
      .min(1)
      .max(CONNECTOR_EVENT_BATCH_LIMIT),
  })
  .strict();

/** Hosted discovery retains exact immutable receive identity across the trusted instance boundary. */
export const ManagedConnectorEventDefinitionSchema = ConnectorEventDefinitionSchema.extend({
  hostedDefinitionId: z.string().uuid(),
}).strict();
/** Bounded hosted event catalogue projection. */
export const ManagedConnectorEventDefinitionPageSchema = z
  .object({
    definitions: z.array(ManagedConnectorEventDefinitionSchema).max(CONNECTOR_EVENT_BATCH_LIMIT),
    nextCursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/** Hosted event catalogue response type. */
export type ManagedConnectorEventDefinitionPage = z.infer<
  typeof ManagedConnectorEventDefinitionPageSchema
>;
/** Bounded event handoff response type. */
export type ManagedConnectorEventPullResponse = z.infer<
  typeof ManagedConnectorEventPullResponseSchema
>;
/** Exact acknowledgement response with no payload. */
export const ManagedConnectorEventAckResponseSchema = z
  .object({ acknowledged: z.number().int().min(0).max(CONNECTOR_EVENT_BATCH_LIMIT) })
  .strict();

/** Public immutable notification definition; provider-owned identifiers remain private. */
export const ConnectionEventDefinitionSchema = ConnectorEventDefinitionSchema.extend({
  id: z.string().min(1).max(256),
}).strict();
/** One bounded connection notification discovery page. */
export const ConnectionEventDefinitionPageSchema = z
  .object({
    definitions: z.array(ConnectionEventDefinitionSchema).max(CONNECTOR_EVENT_BATCH_LIMIT),
    nextCursor: z.string().min(1).max(512).optional(),
  })
  .strict();
/** Payload-free owner projection of one exact receive subscription. */
export const ConnectionEventSubscriptionSchema = z
  .object({
    id: z.string().min(1).max(256),
    connectionId: ConnectionIdSchema,
    definitionId: z.string().min(1).max(256),
    eventType: z.string().min(1).max(256),
    displayName: z.string().min(1).max(512),
    deliveryMode: ConnectorEventDeliveryModeSchema,
    expectedCadenceSeconds: z.number().int().positive().nullable(),
    agentId: z.string().min(1).max(256),
    destination: ConnectorEventDestinationSchema,
    filter: z.record(z.string(), z.unknown()),
    scopeVersion: z.number().int().positive(),
    state: z.enum(['active', 'pending', 'revoked', 'unavailable']),
  })
  .strict();
/** Explicit owner receive intent. The server namespaces this idempotency key beneath the owner. */
export const CreateConnectionEventSubscriptionSchema = ConnectorReceiveScopeSchema.omit({
  connectionId: true,
})
  .extend({
    requestId: z.string().uuid(),
    manageExistingTrigger: z.boolean().default(false),
  })
  .strict();
/** Write-only BYO signing setup; the response never returns signing or content keys. */
export const ConfigureConnectionEventSourceSchema = z
  .object({ webhookSecret: z.string().min(16).max(4096), publicOrigin: z.string().url() })
  .strict();
/** Notification setup status with no credential references or key material. */
export const ConnectionEventSourceStatusSchema = z
  .object({
    setupMode: z.enum(['managed', 'byo_webhook', 'unavailable']),
    configured: z.boolean(),
    endpoint: z.string().url().nullable(),
    reason: z.string().max(512).nullable(),
  })
  .strict();
/** Public notification definition page type. */
export type ConnectionEventDefinitionPage = z.infer<typeof ConnectionEventDefinitionPageSchema>;
/** Public notification subscription type. */
export type ConnectionEventSubscription = z.infer<typeof ConnectionEventSubscriptionSchema>;
/** Owner receive creation intent type. */
export type CreateConnectionEventSubscription = z.infer<
  typeof CreateConnectionEventSubscriptionSchema
>;
/** Write-only source setup input type. */
export type ConfigureConnectionEventSource = z.infer<typeof ConfigureConnectionEventSourceSchema>;
/** Public notification source setup type. */
export type ConnectionEventSourceStatus = z.infer<typeof ConnectionEventSourceStatusSchema>;

/** Bounded owner subscription page, including revoked history without provider identifiers. */
export const ConnectionEventSubscriptionPageSchema = z
  .object({
    subscriptions: z.array(ConnectionEventSubscriptionSchema).max(CONNECTOR_EVENT_BATCH_LIMIT),
    nextCursor: z.string().min(1).max(256).optional(),
  })
  .strict();
/** Public notification subscription page type. */
export type ConnectionEventSubscriptionPage = z.infer<typeof ConnectionEventSubscriptionPageSchema>;

/** Strict program query; omitting the canonical agent never widens notification access. */
export const ConnectorAgentEventSubscriptionQuerySchema = z
  .object({
    agentId: z.string().trim().min(1).max(256),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(CONNECTOR_EVENT_BATCH_LIMIT).optional(),
  })
  .strict();

/** Read-only receive-grant projection with the account aliases already visible to that agent. */
export const ConnectorAgentEventSubscriptionSchema = ConnectionEventSubscriptionSchema.extend({
  toolkit: z.string().min(1).max(128),
  label: z.string().max(512),
  state: z.enum(['active', 'unavailable']),
}).strict();

/** Bounded subscription visibility for exactly one canonical agent. */
export const ConnectorAgentEventSubscriptionPageSchema = z
  .object({
    agentId: z.string().min(1).max(256),
    subscriptions: z.array(ConnectorAgentEventSubscriptionSchema).max(CONNECTOR_EVENT_BATCH_LIMIT),
    nextCursor: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .refine(
    (page) => page.subscriptions.every((subscription) => subscription.agentId === page.agentId),
    {
      message: 'Notification access must belong to the selected agent.',
    }
  );

/** Validated read-only agent subscription page. */
export type ConnectorAgentEventSubscriptionPage = z.infer<
  typeof ConnectorAgentEventSubscriptionPageSchema
>;
/** Exact immutable receive approval receipt; it contains no payload or external account reference. */
export const ConnectorEventGrantSelectionSchema = z
  .object({
    subscriptionId: z.string().min(1).max(256),
    scopeVersion: z.number().int().positive(),
    definitionId: z.string().min(1).max(256),
    eventScopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Exact durable selection returned by private owner review. */
export type ConnectorEventGrantSelection = z.infer<typeof ConnectorEventGrantSelectionSchema>;
