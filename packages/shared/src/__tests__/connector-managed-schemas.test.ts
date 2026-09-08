import { describe, expect, it } from 'vitest';
import {
  MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS,
  MANAGED_CONNECTOR_EXECUTION_PERMISSIONS,
  MANAGED_CONNECTOR_INSTANCE_KEY_PERMISSIONS,
  MANAGED_CONNECTOR_USAGE_PERMISSIONS,
  ManagedConnectorAuthorityCommandSchema,
  ManagedConnectorAuthorityCommandStatusSchema,
  ManagedConnectorExecutionReceiptSchema,
  ManagedConnectorExecutionRequestSchema,
  ManagedConnectorExecutionResponseSchema,
} from '../connector-managed-schemas.js';

describe('managed connector wire schemas', () => {
  it('exports the exact linked-instance connector permissions without wildcards', () => {
    expect(MANAGED_CONNECTOR_INSTANCE_KEY_PERMISSIONS).toEqual({
      instance: ['link'],
      connectors: ['authority', 'execute', 'usage', 'events'],
    });
    expect(MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS).toEqual({
      instance: ['link'],
      connectors: ['authority'],
    });
    expect(MANAGED_CONNECTOR_EXECUTION_PERMISSIONS).toEqual({
      instance: ['link'],
      connectors: ['execute'],
    });
    expect(MANAGED_CONNECTOR_USAGE_PERMISSIONS).toEqual({
      instance: ['link'],
      connectors: ['usage'],
    });
  });

  it('accepts an exact grant replacement and rejects caller-selected authority fields', () => {
    const command = {
      version: 1,
      commandId: 'cmd-1',
      managedConnectionId: 'managed-1',
      scopeVersion: 2,
      kind: 'replace_agent_grants',
      agentId: 'agent-1',
      revisions: [
        {
          hostedRevisionId: '11111111-1111-4111-8111-111111111111',
          operationSlug: 'GMAIL_FETCH_EMAILS',
          toolkitVersion: 'v3',
          schemaHash: 'sha256:a',
        },
      ],
    };
    expect(ManagedConnectorAuthorityCommandSchema.parse(command)).toEqual(command);
    const { hostedRevisionId: _hostedRevisionId, ...legacySelector } = command.revisions[0];
    expect(
      ManagedConnectorAuthorityCommandSchema.safeParse({ ...command, revisions: [legacySelector] })
        .success
    ).toBe(false);
    expect(
      ManagedConnectorAuthorityCommandSchema.safeParse({
        ...command,
        revisions: [{ ...command.revisions[0], hostedRevisionId: 'caller-invented-non-uuid' }],
      }).success
    ).toBe(false);

    expect(
      ManagedConnectorAuthorityCommandSchema.safeParse({ ...command, tenantId: 'caller-choice' })
        .success
    ).toBe(false);
    expect(
      ManagedConnectorAuthorityCommandSchema.safeParse({
        ...command,
        revisions: [{ ...command.revisions[0], capabilityClassification: 'read' }],
      }).success
    ).toBe(false);
  });

  it('keeps lifecycle cleanup separate from durable authority application', () => {
    expect(
      ManagedConnectorAuthorityCommandStatusSchema.parse({
        version: 1,
        commandId: 'cmd-2',
        managedConnectionId: 'managed-1',
        scopeVersion: 3,
        state: 'applied',
        externalCleanup: 'pending',
      })
    ).toMatchObject({ state: 'applied', externalCleanup: 'pending' });
  });

  it('requires the broker-derived agent, attempt index, and scope version', () => {
    const request = {
      version: 1,
      logicalOperationId: 'logical-1',
      attemptId: 'attempt-1',
      attemptIndex: 1,
      managedConnectionId: 'managed-1',
      agentId: 'agent-1',
      grantScopeVersion: 4,
      attribution: {
        surface: 'mcp',
        actorKind: 'agent',
        actorId: 'agent-1',
        sessionId: 'session-1',
      },
      revision: {
        hostedRevisionId: '11111111-1111-4111-8111-111111111111',
        operationSlug: 'GMAIL_FETCH_EMAILS',
        toolkitVersion: 'v3',
        schemaHash: 'sha256:a',
      },
      arguments: { maxResults: 10 },
    };
    expect(ManagedConnectorExecutionRequestSchema.parse(request)).toEqual(request);
    const { agentId: _agentId, ...withoutAgent } = request;
    expect(ManagedConnectorExecutionRequestSchema.safeParse(withoutAgent).success).toBe(false);
    const { attribution: _attribution, ...withoutAttribution } = request;
    expect(ManagedConnectorExecutionRequestSchema.safeParse(withoutAttribution).success).toBe(
      false
    );
    expect(
      ManagedConnectorExecutionRequestSchema.safeParse({
        ...request,
        attribution: { ...request.attribution, tenantId: 'caller-choice' },
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorExecutionRequestSchema.safeParse({
        ...request,
        attribution: { ...request.attribution, actorId: '' },
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorExecutionRequestSchema.safeParse({
        ...request,
        upstreamIdempotencyKey: 'caller-choice',
      }).success
    ).toBe(false);
  });

  it('permits a null completion time for an unknown receipt and exposes no provider log id', () => {
    const receipt = {
      version: 1,
      receiptId: 'receipt-1',
      logicalOperationId: 'logical-1',
      attemptId: 'attempt-1',
      attemptIndex: 1,
      outcome: 'outcome_unknown',
      completedAt: null,
      recordedAt: '2026-09-06T18:00:00.000Z',
    };
    expect(ManagedConnectorExecutionReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      ManagedConnectorExecutionReceiptSchema.safeParse({
        ...receipt,
        providerLogId: 'private-provider-log',
      }).success
    ).toBe(false);
  });

  it('keeps duplicate recovery receipt-only and binds completed results to receipt truth', () => {
    const receipt = {
      version: 1,
      receiptId: 'receipt-1',
      logicalOperationId: 'logical-1',
      attemptId: 'attempt-1',
      attemptIndex: 1,
      outcome: 'success',
      completedAt: '2026-09-06T18:00:00.000Z',
      recordedAt: '2026-09-06T18:00:01.000Z',
    } as const;
    expect(
      ManagedConnectorExecutionResponseSchema.parse({ state: 'receipt_only', receipt })
    ).toEqual({ state: 'receipt_only', receipt });
    expect(
      ManagedConnectorExecutionResponseSchema.safeParse({
        state: 'completed',
        result: { status: 'error', code: 'FAILED', message: 'failed', retryable: false },
        receipt,
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorExecutionResponseSchema.safeParse({
        state: 'receipt_only',
        receipt,
        result: { status: 'success', data: { privateRecoveredResult: true } },
      }).success
    ).toBe(false);
  });
});
