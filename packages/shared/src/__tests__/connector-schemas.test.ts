import { describe, expect, it } from 'vitest';
import {
  ConnectorExecutionResponseSchema,
  ConnectorManagementReviewActionSchema,
  ConnectorManagementReviewDecisionResultSchema,
  ConnectorOperationRevisionSchema,
  ConnectorProgramReviewStatusSchema,
  ConnectorProgramExecutionRequestSchema,
  ConnectorProviderExecuteResultSchema,
  ConnectorReviewActionSchema,
  ConnectorUsageItemSchema,
  decodeConnectorReviewAction,
  encodeConnectorReviewAction,
} from '../connector-schemas.js';

describe('connector execution contracts', () => {
  it('requires retry policy on immutable revisions and retryability on provider errors', () => {
    expect(
      ConnectorOperationRevisionSchema.safeParse({
        id: 'revision-a',
        providerInstanceId: 'provider-a',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:a',
        capabilityClassification: 'read',
        inputSchema: { type: 'object' },
        discoveredAt: new Date(0).toISOString(),
      }).success
    ).toBe(false);
    expect(
      ConnectorProviderExecuteResultSchema.safeParse({
        status: 'error',
        code: 'temporary',
        message: 'Try again',
      }).success
    ).toBe(false);
    expect(
      ConnectorProviderExecuteResultSchema.safeParse({
        status: 'error',
        code: 'temporary',
        message: 'Try again',
        retryable: true,
      }).success
    ).toBe(true);
  });

  it('rejects caller-supplied private routing and operation-attempt selectors', () => {
    const publicInput = {
      agentId: 'agent-a',
      connectionId: 'connection-a',
      operationRevisionId: 'revision-a',
      arguments: { query: 'hello' },
    };
    expect(ConnectorProgramExecutionRequestSchema.safeParse(publicInput).success).toBe(true);
    for (const injected of [
      { ownerId: 'owner-b' },
      { sessionId: 'session-b' },
      { externalAccountRef: 'private-account' },
      { logicalOperationId: 'chosen-logical-id' },
      { upstreamIdempotencyKey: 'chosen-key' },
    ]) {
      expect(
        ConnectorProgramExecutionRequestSchema.safeParse({ ...publicInput, ...injected }).success
      ).toBe(false);
    }
  });

  it('keeps provider log ids out of public execution and usage DTOs', () => {
    expect(
      ConnectorExecutionResponseSchema.safeParse({
        logicalOperationId: 'logical-a',
        attemptCount: 1,
        result: { status: 'success', data: { ok: true }, providerLogId: 'private-log' },
      }).success
    ).toBe(false);
    expect(
      ConnectorUsageItemSchema.safeParse({
        logicalOperationId: 'logical-a',
        attemptIndex: 1,
        surface: 'mcp',
        actorKind: 'runtime',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        toolkit: 'gmail',
        operationRevisionId: 'revision-a',
        operationSlug: 'gmail.messages.list',
        payer: 'operator_byo',
        outcome: 'success',
        providerLogId: 'private-log',
        startedAt: new Date(0).toISOString(),
      }).success
    ).toBe(false);
  });

  it('keeps program review status lifecycle-bound and free of owner context', () => {
    const base = {
      reviewRequestId: 'review-a',
      reviewUrl: '/connections?review=review-a',
      targetStatus: 'available',
      expiresAt: new Date(1_000).toISOString(),
    };
    expect(
      ConnectorProgramReviewStatusSchema.safeParse({ ...base, state: 'pending' }).success
    ).toBe(true);
    expect(
      ConnectorProgramReviewStatusSchema.safeParse({
        ...base,
        state: 'resolving',
        resolvedAt: '2026-09-06T12:01:00.000Z',
      }).success
    ).toBe(true);
    expect(
      ConnectorProgramReviewStatusSchema.safeParse({
        ...base,
        state: 'approved',
        resolvedAt: new Date(500).toISOString(),
        outcome: 'applied',
      }).success
    ).toBe(true);
    expect(
      ConnectorProgramReviewStatusSchema.safeParse({
        ...base,
        state: 'approved',
        resolvedAt: new Date(500).toISOString(),
        outcome: 'outcome_unknown',
      }).success
    ).toBe(true);
    expect(
      ConnectorProgramReviewStatusSchema.safeParse({
        ...base,
        state: 'approved',
        resolvedAt: new Date(500).toISOString(),
        outcome: 'authentication_required',
      }).success
    ).toBe(true);
    for (const candidate of [
      { ...base, state: 'pending', outcome: 'applied' },
      { ...base, state: 'approved', outcome: 'denied' },
      { ...base, state: 'approved', outcome: 'connect_authentication_required' },
      { ...base, state: 'denied', outcome: 'denied' },
      { ...base, state: 'expired', outcome: 'applied' },
      { ...base, state: 'pending', context: { kind: 'pause' } },
      { ...base, state: 'pending', action: { kind: 'pause' } },
      { ...base, state: 'pending', authentication: { flowId: 'private-flow' } },
      { ...base, state: 'pending', targetStatus: 'unknown' },
    ]) {
      expect(ConnectorProgramReviewStatusSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('keeps review approval distinct from a completed connection', () => {
    const review = {
      reviewRequestId: 'review-a',
      action: {
        version: 1,
        kind: 'connect',
        providerInstanceId: 'provider-a',
        toolkit: 'gmail',
      },
      requesterKind: 'program',
      context: {
        kind: 'connect',
        providerInstanceId: 'provider-a',
        providerDisplayName: 'Composio',
        toolkit: 'gmail',
      },
      targetStatus: 'available',
      state: 'approved',
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(1_000).toISOString(),
      resolvedAt: new Date(500).toISOString(),
      resolution: {
        kind: 'connect_authentication_required',
        reviewRequestId: 'review-a',
        authentication: { flowId: 'flow-a', authorizeUrl: 'https://example.test/authorize' },
      },
    } as const;
    expect(
      ConnectorManagementReviewDecisionResultSchema.safeParse({
        review,
      }).success
    ).toBe(true);
    expect(
      ConnectorManagementReviewActionSchema.safeParse({
        version: 1,
        kind: 'reconnect',
        connectionId: 'connection-a',
      }).success
    ).toBe(false);
    expect(
      ConnectorManagementReviewActionSchema.safeParse({
        version: 1,
        kind: 'pause',
        connectionId: 'connection-a',
      }).success
    ).toBe(true);
    for (const operationRevisionIds of [[], ['revision-a', 'revision-a']]) {
      expect(
        ConnectorManagementReviewActionSchema.safeParse({
          version: 1,
          kind: 'set_agent_access',
          connectionId: 'connection-a',
          agentId: 'agent-a',
          operationRevisionIds,
        }).success
      ).toBe(false);
    }
  });

  it('binds management review resolution to its lifecycle, action, and identity', () => {
    const timestamps = {
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(1_000).toISOString(),
      resolvedAt: new Date(500).toISOString(),
    };
    const pauseAction = {
      version: 1,
      kind: 'pause',
      connectionId: 'connection-a',
    } as const;
    const connectAction = {
      version: 1,
      kind: 'connect',
      providerInstanceId: 'provider-a',
      toolkit: 'gmail',
    } as const;
    const base = {
      reviewRequestId: 'review-a',
      requesterKind: 'program',
      context: {
        kind: 'pause',
        connection: {
          connectionId: 'connection-a',
          label: 'Work Gmail',
          toolkit: 'gmail',
          status: 'active',
          custody: 'managed',
          providerDisplayName: 'Composio',
          providerStatus: 'available',
          reconciliationStatus: 'ready',
        },
      },
      targetStatus: 'available',
      ...timestamps,
    } as const;

    for (const review of [
      { ...base, action: pauseAction, state: 'pending', resolution: { kind: 'applied' } },
      { ...base, action: pauseAction, state: 'expired', resolution: { kind: 'denied' } },
      { ...base, action: pauseAction, state: 'approved' },
      { ...base, action: pauseAction, state: 'approved', resolution: { kind: 'denied' } },
      {
        ...base,
        action: pauseAction,
        state: 'approved',
        resolution: {
          kind: 'connect_authentication_required',
          reviewRequestId: 'review-a',
          authentication: { flowId: 'flow-a' },
        },
      },
      { ...base, action: connectAction, state: 'approved', resolution: { kind: 'applied' } },
      {
        ...base,
        action: connectAction,
        state: 'approved',
        resolution: {
          kind: 'connect_authentication_required',
          reviewRequestId: 'review-b',
          authentication: { flowId: 'flow-a' },
        },
      },
      { ...base, action: connectAction, state: 'denied' },
      {
        ...base,
        action: connectAction,
        state: 'denied',
        resolution: { kind: 'applied' },
      },
    ]) {
      expect(ConnectorManagementReviewDecisionResultSchema.safeParse({ review }).success).toBe(
        false
      );
    }

    expect(
      ConnectorManagementReviewDecisionResultSchema.safeParse({
        review: {
          ...base,
          action: pauseAction,
          state: 'approved',
          resolution: { kind: 'outcome_unknown' },
        },
      }).success
    ).toBe(true);

    expect(
      ConnectorManagementReviewDecisionResultSchema.safeParse({
        review: {
          ...base,
          action: pauseAction,
          state: 'approved',
          resolution: { kind: 'applied' },
        },
        outcome: { kind: 'applied' },
      }).success
    ).toBe(false);
  });
});

describe('ConnectorReviewActionSchema', () => {
  it('round-trips one canonical discriminated action', () => {
    const action = ConnectorReviewActionSchema.parse({
      version: 1,
      kind: 'set_agent_access',
      connectionId: 'connection-1',
      agentId: 'agent-a',
      operationRevisionIds: ['revision-read', 'revision-write'],
    });

    expect(decodeConnectorReviewAction(encodeConnectorReviewAction(action))).toEqual(action);
  });

  it('validates an agent connection request without any private account selector', () => {
    const action = ConnectorReviewActionSchema.parse({
      version: 1,
      kind: 'agent_connection_request',
      serviceSlug: 'gmail',
      reason: 'Read messages for the current task.',
      requestedOperations: ['gmail.messages.list'],
    });

    expect(action).toEqual({
      version: 1,
      kind: 'agent_connection_request',
      serviceSlug: 'gmail',
      reason: 'Read messages for the current task.',
      requestedOperations: ['gmail.messages.list'],
      requestedEvents: [],
    });
    expect(
      ConnectorReviewActionSchema.safeParse({ ...action, connectionId: 'private-choice' }).success
    ).toBe(false);
  });

  it.each([
    {
      version: 1,
      kind: 'grant_everything',
      connectionId: 'connection-1',
    },
    {
      version: 2,
      kind: 'pause',
      connectionId: 'connection-1',
    },
    {
      version: 1,
      kind: 'pause',
      connectionId: 'connection-1',
      operationRevisionIds: ['wildcard'],
    },
  ])('rejects unknown kinds, versions, and fields: $kind v$version', (candidate) => {
    expect(ConnectorReviewActionSchema.safeParse(candidate).success).toBe(false);
  });
});
