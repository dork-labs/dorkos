import { describe, expect, it } from 'vitest';
import {
  MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS,
  MANAGED_CONNECTOR_EXECUTION_PERMISSIONS,
  MANAGED_CONNECTOR_INSTANCE_KEY_PERMISSIONS,
  MANAGED_CONNECTOR_ERROR_CODES,
  MANAGED_CONNECTOR_USAGE_PERMISSIONS,
  ManagedConnectorAuthorityCommandSchema,
  ManagedConnectorErrorBodySchema,
  ManagedConnectorAuthorityCommandStatusSchema,
  ManagedConnectorExecutionReceiptSchema,
  ManagedConnectorAnyExecutionRequestSchema,
  ManagedConnectorExecutionRequestSchema,
  ManagedConnectorExecutionResponseSchema,
  ManagedConnectorExtensionExecutionRequestSchema,
} from '../connector-managed-schemas.js';

describe('managed connector error body', () => {
  it('parses the legacy refusal body the control plane sends', () => {
    expect(
      ManagedConnectorErrorBodySchema.parse({
        error: MANAGED_CONNECTOR_ERROR_CODES.permissionUpgradeRequired,
      })
    ).toEqual({ error: 'permission_upgrade_required' });
    expect(
      ManagedConnectorErrorBodySchema.parse({
        error: 'managed_connectors_unavailable',
        reason: 'toolkit temporarily down',
      })
    ).toEqual({ error: 'managed_connectors_unavailable', reason: 'toolkit temporarily down' });
  });

  it('tolerates a key the cloud adds later instead of failing the refusal', () => {
    expect(ManagedConnectorErrorBodySchema.parse({ error: 'conflict', requestId: 'r-1' })).toEqual({
      error: 'conflict',
      requestId: 'r-1',
    });
  });

  it('rejects a body without an error code and bounds every string', () => {
    expect(ManagedConnectorErrorBodySchema.safeParse({}).success).toBe(false);
    expect(ManagedConnectorErrorBodySchema.safeParse({ error: 'x'.repeat(101) }).success).toBe(
      false
    );
    expect(
      ManagedConnectorErrorBodySchema.safeParse({ error: 'conflict', reason: 'x'.repeat(1_001) })
        .success
    ).toBe(false);
  });
});

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

  it('never lets an agent call name the extension subject (DOR-3547)', () => {
    const request = {
      version: 1,
      logicalOperationId: 'logical-1',
      attemptId: 'attempt-1',
      attemptIndex: 1,
      managedConnectionId: 'managed-1',
      agentId: 'agent-1',
      grantScopeVersion: 4,
      attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-1' },
      revision: {
        hostedRevisionId: '11111111-1111-4111-8111-111111111111',
        operationSlug: 'LINEAR_LIST_LINEAR_PROJECTS',
        toolkitVersion: 'v3',
        schemaHash: 'sha256:a',
      },
      arguments: {},
    };
    // The owner-wide scope still rides beside the calling agent's id.
    expect(
      ManagedConnectorExecutionRequestSchema.safeParse({ ...request, grantSubject: 'every_agent' })
        .success
    ).toBe(true);
    // An extension's grant can't be reached by an agent id plus a subject flag.
    expect(
      ManagedConnectorExecutionRequestSchema.safeParse({ ...request, grantSubject: 'extension' })
        .success
    ).toBe(false);
    // Nor by an agent id shaped like one: the scope is named by `grantSubject`
    // alone, so this is still an agent's call on the agent's own scope.
    const prefixed = ManagedConnectorExecutionRequestSchema.parse({
      ...request,
      agentId: 'extension:flow-owner',
    });
    expect(prefixed.grantSubject).toBeUndefined();
    expect(prefixed.agentId).toBe('extension:flow-owner');
  });

  it("never lets an agent's request carry an extension's attribution (DOR-3980)", () => {
    const request = {
      version: 1,
      logicalOperationId: 'logical-1',
      attemptId: 'attempt-1',
      attemptIndex: 1,
      managedConnectionId: 'managed-1',
      agentId: 'agent-1',
      grantScopeVersion: 4,
      attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-1' },
      revision: {
        hostedRevisionId: '11111111-1111-4111-8111-111111111111',
        operationSlug: 'LINEAR_LIST_LINEAR_PROJECTS',
        toolkitVersion: 'v3',
        schemaHash: 'sha256:a',
      },
      arguments: {},
    };
    for (const attribution of [
      { ...request.attribution, surface: 'extension' },
      { ...request.attribution, actorKind: 'extension' },
    ]) {
      expect(
        ManagedConnectorExecutionRequestSchema.safeParse({ ...request, attribution }).success
      ).toBe(false);
    }
  });

  describe('an extension reads a managed connection (DOR-3980)', () => {
    const selector = {
      hostedRevisionId: '11111111-1111-4111-8111-111111111111',
      operationSlug: 'LINEAR_LIST_LINEAR_PROJECTS',
      toolkitVersion: 'v3',
      schemaHash: 'sha256:a',
    };
    const command = {
      version: 1,
      commandId: 'cmd-ext-1',
      managedConnectionId: 'managed-1',
      scopeVersion: 1,
      kind: 'replace_extension_grants',
      extensionId: 'flow-owner',
      access: 'read',
      revisions: [selector],
    };
    const request = {
      version: 1,
      logicalOperationId: 'logical-ext-1',
      attemptId: 'attempt-ext-1',
      attemptIndex: 1,
      managedConnectionId: 'managed-1',
      grantSubject: 'extension',
      extensionId: 'flow-owner',
      grantScopeVersion: 1,
      attribution: { surface: 'extension', actorKind: 'extension', actorId: 'flow-owner' },
      revision: selector,
      arguments: { first: 5 },
    };

    it('replaces an extension grant with read revisions, and an empty set ends it', () => {
      expect(ManagedConnectorAuthorityCommandSchema.parse(command)).toEqual(command);
      expect(
        ManagedConnectorAuthorityCommandSchema.parse({ ...command, revisions: [] })
      ).toMatchObject({ kind: 'replace_extension_grants', revisions: [] });
    });

    it('refuses an extension grant that is not read, names an agent, or uses a prefixed id', () => {
      for (const bad of [
        { ...command, access: 'write' },
        { ...command, access: undefined },
        { ...command, agentId: 'agent-1' },
        { ...command, extensionId: 'extension:flow-owner' },
        { ...command, extensionId: 'Flow' },
        { ...command, extensionId: '' },
        { ...command, revisions: [{ ...selector, capabilityClassification: 'read' }] },
        { ...command, tenantId: 'caller-choice' },
      ]) {
        expect(ManagedConnectorAuthorityCommandSchema.safeParse(bad).success).toBe(false);
      }
    });

    it('parses an extension read with no agent, named the same in its attribution', () => {
      expect(ManagedConnectorExtensionExecutionRequestSchema.parse(request)).toEqual(request);
      expect(ManagedConnectorAnyExecutionRequestSchema.parse(request)).toEqual(request);
    });

    it('refuses an extension read that names an agent, another subject or another extension', () => {
      for (const bad of [
        { ...request, agentId: 'agent-1' },
        { ...request, grantSubject: 'agent' },
        { ...request, grantSubject: 'every_agent' },
        { ...request, grantSubject: undefined },
        { ...request, attribution: { ...request.attribution, actorId: 'other-extension' } },
        { ...request, attribution: { ...request.attribution, surface: 'mcp' } },
        { ...request, attribution: { ...request.attribution, actorKind: 'agent' } },
        { ...request, attribution: { ...request.attribution, sessionId: 'session-1' } },
        { ...request, extensionId: 'extension:flow-owner' },
        { ...request, upstreamIdempotencyKey: 'caller-choice' },
      ]) {
        expect(ManagedConnectorExtensionExecutionRequestSchema.safeParse(bad).success).toBe(false);
        expect(ManagedConnectorAnyExecutionRequestSchema.safeParse(bad).success).toBe(false);
      }
    });

    it("still parses today's agent request unchanged through the union", () => {
      const agentRequest = {
        version: 1,
        logicalOperationId: 'logical-1',
        attemptId: 'attempt-1',
        attemptIndex: 1,
        managedConnectionId: 'managed-1',
        agentId: 'agent-1',
        grantScopeVersion: 4,
        attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-1' },
        revision: selector,
        arguments: {},
      };
      expect(ManagedConnectorAnyExecutionRequestSchema.parse(agentRequest)).toEqual(agentRequest);
      expect(ManagedConnectorExecutionRequestSchema.parse(agentRequest)).toEqual(agentRequest);
    });
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
