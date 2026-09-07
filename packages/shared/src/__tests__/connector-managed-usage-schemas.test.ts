import { describe, expect, it } from 'vitest';

import {
  ManagedConnectorUsageRequestSchema,
  ManagedConnectorUsageResponseSchema,
} from '../connector-managed-usage-schemas.js';

const receipt = {
  version: 1 as const,
  receiptId: 'receipt-a',
  logicalOperationId: 'logical-a',
  attemptId: 'attempt-a',
  attemptIndex: 1,
  outcome: 'success' as const,
  completedAt: '2026-09-06T00:00:01.000Z',
  recordedAt: '2026-09-06T00:00:01.000Z',
};

const item = {
  attemptId: 'attempt-a',
  logicalOperationId: 'logical-a',
  attemptIndex: 1,
  managedConnectionId: 'managed-a',
  agentId: 'agent-a',
  revision: {
    operationSlug: 'gmail.messages.list',
    toolkitVersion: '20260906_00',
    schemaHash: 'sha256:schema-a',
  },
  toolkit: 'gmail',
  payer: 'dorkos_managed' as const,
  surface: 'mcp' as const,
  actorKind: 'agent' as const,
  startedAt: '2026-09-06T00:00:00.000Z',
};

describe('managed connector usage wire', () => {
  it('parses bounded filters and defaults one authoritative page limit', () => {
    expect(ManagedConnectorUsageRequestSchema.parse({ version: 1 })).toEqual({
      version: 1,
      limit: 50,
    });
    expect(() =>
      ManagedConnectorUsageRequestSchema.parse({ version: 1, tenantId: 'foreign' })
    ).toThrow();
    expect(() => ManagedConnectorUsageRequestSchema.parse({ version: 1, limit: 101 })).toThrow();
  });

  it('keeps pending intents distinct from immutable terminal receipts', () => {
    expect(
      ManagedConnectorUsageResponseSchema.parse({
        version: 1,
        status: 'available',
        counts: { logicalOperationCount: 1, attemptCount: 2 },
        items: [
          { ...item, state: 'pending' },
          {
            ...item,
            attemptId: 'attempt-b',
            state: 'recorded',
            receipt: { ...receipt, attemptId: 'attempt-b' },
          },
        ],
      })
    ).toMatchObject({ status: 'available', counts: { attemptCount: 2 } });
    expect(() =>
      ManagedConnectorUsageResponseSchema.parse({
        version: 1,
        status: 'available',
        counts: { logicalOperationCount: 1, attemptCount: 1 },
        items: [{ ...item, state: 'pending', receipt }],
      })
    ).toThrow();
    expect(() =>
      ManagedConnectorUsageResponseSchema.parse({
        version: 1,
        status: 'available',
        counts: { logicalOperationCount: 1, attemptCount: 1 },
        items: [
          {
            ...item,
            state: 'recorded',
            receipt: { ...receipt, logicalOperationId: 'another-logical-operation' },
          },
        ],
      })
    ).toThrow('Recorded usage attribution does not match its receipt.');
  });

  it('rejects private provider and execution payload fields', () => {
    for (const privateField of [
      { externalAccountRef: 'ca_private' },
      { providerUserId: 'provider-user' },
      { arguments: { secret: true } },
      { result: { private: true } },
      { providerLogId: 'provider-log' },
    ]) {
      expect(() =>
        ManagedConnectorUsageResponseSchema.parse({
          version: 1,
          status: 'available',
          counts: { logicalOperationCount: 1, attemptCount: 1 },
          items: [{ ...item, state: 'recorded', receipt, ...privateField }],
        })
      ).toThrow();
    }
  });

  it('never turns an unavailable authoritative read into zero usage', () => {
    expect(
      ManagedConnectorUsageResponseSchema.parse({
        version: 1,
        status: 'unavailable',
        reason: 'Managed usage is temporarily unavailable.',
      })
    ).toEqual({
      version: 1,
      status: 'unavailable',
      reason: 'Managed usage is temporarily unavailable.',
    });
    expect(() =>
      ManagedConnectorUsageResponseSchema.parse({
        version: 1,
        status: 'unavailable',
        reason: 'Unavailable.',
        counts: { logicalOperationCount: 0, attemptCount: 0 },
      })
    ).toThrow();
  });
});
