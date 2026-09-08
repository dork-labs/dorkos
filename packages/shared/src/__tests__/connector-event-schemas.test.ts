import { describe, expect, it } from 'vitest';
import {
  ConfigureConnectionEventSourceSchema,
  ConnectorAgentEventSubscriptionPageSchema,
  ConnectorAgentEventSubscriptionQuerySchema,
  ConnectionEventSourceStatusSchema,
  ConnectionEventSubscriptionPageSchema,
  ConnectorReceiveScopeSchema,
  CreateConnectionEventSubscriptionSchema,
  ConnectorEventGrantSelectionSchema,
} from '../connector-event-schemas.js';

const scope = {
  connectionId: 'connection-1',
  definitionId: 'definition-1',
  agentId: 'agent-1',
  destination: { kind: 'agent', id: 'agent-1' },
  filter: { channel: 'alerts' },
};
describe('owner notification contracts', () => {
  it('refuses provider references and asserted event identity in public consent', () => {
    expect(ConnectorReceiveScopeSchema.parse(scope)).toEqual(scope);
    for (const extra of [
      { hostedDefinitionId: 'remote' },
      { externalAccountRef: 'account' },
      { eventType: 'asserted' },
      { ownerId: 'someone-else' },
    ]) {
      expect(ConnectorReceiveScopeSchema.safeParse({ ...scope, ...extra }).success).toBe(false);
    }
  });
  it('defaults upstream management consent off and requires a distinct request key', () => {
    const { connectionId: _connectionId, ...input } = scope;
    expect(CreateConnectionEventSubscriptionSchema.safeParse(input).success).toBe(false);
    expect(
      CreateConnectionEventSubscriptionSchema.parse({
        ...input,
        requestId: '7337caa2-c19b-4715-aab4-9f33205331f1',
      }).manageExistingTrigger
    ).toBe(false);
    expect(
      CreateConnectionEventSubscriptionSchema.safeParse({
        ...input,
        requestId: '7337caa2-c19b-4715-aab4-9f33205331f1',
        connectionId: 'other',
      }).success
    ).toBe(false);
  });
  it('requires exact immutable approval hashes and positive generations', () => {
    const selection = {
      subscriptionId: 'sub',
      definitionId: 'def',
      scopeVersion: 1,
      eventScopeHash: 'a'.repeat(64),
    };
    expect(ConnectorEventGrantSelectionSchema.parse(selection)).toEqual(selection);
    expect(
      ConnectorEventGrantSelectionSchema.safeParse({ ...selection, scopeVersion: 0 }).success
    ).toBe(false);
    expect(
      ConnectorEventGrantSelectionSchema.safeParse({ ...selection, eventScopeHash: 'not-an-ack' })
        .success
    ).toBe(false);
  });
  it('bounds pages without permitting content in subscription metadata', () => {
    const subscription = {
      ...scope,
      id: 'sub',
      eventType: 'NEW_MESSAGE',
      displayName: 'New message',
      deliveryMode: 'unknown',
      expectedCadenceSeconds: null,
      scopeVersion: 1,
      state: 'pending',
    };
    expect(
      ConnectionEventSubscriptionPageSchema.parse({
        subscriptions: [subscription],
        nextCursor: 'next',
      }).subscriptions
    ).toHaveLength(1);
    expect(
      ConnectionEventSubscriptionPageSchema.safeParse({
        subscriptions: Array.from({ length: 101 }, () => subscription),
      }).success
    ).toBe(false);
    expect(
      ConnectionEventSubscriptionPageSchema.safeParse({
        subscriptions: [{ ...subscription, content: 'private message' }],
      }).success
    ).toBe(false);
  });
  it('accepts signing setup only as an explicit write-only input', () => {
    expect(
      ConfigureConnectionEventSourceSchema.safeParse({
        webhookSecret: 'synthetic-secret-value',
        publicOrigin: 'https://local.example',
      }).success
    ).toBe(true);
    expect(
      ConfigureConnectionEventSourceSchema.safeParse({
        webhookSecret: 'synthetic-secret-value',
        publicOrigin: 'https://local.example',
        payloadKey: 'wrong',
      }).success
    ).toBe(false);
  });
  it('requires server-declared setup mode separately from configuration status', () => {
    expect(
      ConnectionEventSourceStatusSchema.safeParse({ configured: false, endpoint: null }).success
    ).toBe(false);
    expect(
      ConnectionEventSourceStatusSchema.parse({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }).setupMode
    ).toBe('managed');
    expect(
      ConnectionEventSourceStatusSchema.parse({
        setupMode: 'unavailable',
        configured: false,
        endpoint: null,
        reason: 'Notifications are not available for this service.',
      }).configured
    ).toBe(false);
  });
});

describe('program receive visibility contracts', () => {
  it('requires explicit canonical agent scope and bounds the cursor/page', () => {
    expect(
      ConnectorAgentEventSubscriptionQuerySchema.parse({ agentId: ' agent-a ', limit: '10' })
    ).toEqual({ agentId: 'agent-a', limit: 10 });
    for (const query of [
      {},
      { agentId: ' ' },
      { agentId: 'a', ownerId: 'other' },
      { agentId: 'a', limit: 101 },
      { agentId: 'a', cursor: 'x'.repeat(1025) },
    ])
      expect(ConnectorAgentEventSubscriptionQuerySchema.safeParse(query).success).toBe(false);
  });
  it('rejects mixed agent pages, unapproved states and private provider data', () => {
    const row = {
      ...scope,
      id: 'sub',
      eventType: 'NEW_MESSAGE',
      displayName: 'New message',
      deliveryMode: 'unknown',
      expectedCadenceSeconds: null,
      scopeVersion: 1,
      state: 'active',
      toolkit: 'gmail',
      label: 'Work',
    };
    const page = { agentId: scope.agentId, subscriptions: [row] };
    expect(ConnectorAgentEventSubscriptionPageSchema.parse(page)).toEqual(page);
    for (const extra of [
      { agentId: 'other' },
      { state: 'pending' },
      { providerTriggerRef: 'private' },
      { content: 'private' },
    ])
      expect(
        ConnectorAgentEventSubscriptionPageSchema.safeParse({
          ...page,
          subscriptions: [{ ...row, ...extra }],
        }).success
      ).toBe(false);
    expect(
      ConnectorAgentEventSubscriptionPageSchema.safeParse({
        ...page,
        subscriptions: Array.from({ length: 101 }, () => row),
      }).success
    ).toBe(false);
  });
});
