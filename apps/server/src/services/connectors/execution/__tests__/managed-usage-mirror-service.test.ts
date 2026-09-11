/** Hosted receipt mirror invariants over the real local connector ledger. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectorManagedReceiptRecoveries,
  connectorManagedUsageMirrors,
  connectorOperationRevisions,
  connectorUsageTerminalReceipts,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { ManagedConnectorExecutionReceipt } from '@dorkos/shared/connector-managed-schemas';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../registry.js';
import {
  ManagedUsageMirrorError,
  ManagedUsageMirrorService,
} from '../managed-usage-mirror-service.js';
import { ConnectorUsageStore } from '../usage-store.js';

const NOW = '2026-09-06T12:00:00.000Z';
const LATER = '2026-09-06T12:00:01.000Z';
const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

describe('ManagedUsageMirrorService', () => {
  let db: Db;
  let usage: ConnectorUsageStore;
  let provider: FakeConnectorProvider;
  let connection: ConnectedAccount;
  let receipt: ManagedConnectorExecutionReceipt;

  function recordManagedIntent(attemptId: string, logicalOperationId: string): void {
    usage.recordIntent({
      attemptId,
      logicalOperationId,
      attemptIndex: 1,
      surface: 'mcp',
      actorKind: 'agent',
      actorId: 'agent-a',
      owner: OWNER,
      agentId: 'agent-a',
      connectionId: connection.id,
      providerInstanceId: provider.instanceId,
      providerType: 'dorkos-managed',
      payer: 'dorkos_managed',
      operationRevisionId: 'revision-a',
      startedAt: NOW,
    });
  }

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    usage = new ConnectorUsageStore(db);
    provider = new FakeConnectorProvider();
    const registry = new ConnectorRegistry({ db });
    registry.register(provider);
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });
    connection = registry.recordConnect(provider, (await provider.pollConnect(flowId)).account!);
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'version-a',
        schemaHash: 'sha256:revision-a',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{}',
        discoveredAt: NOW,
      })
      .run();
    recordManagedIntent('attempt-a', 'logical-a');
    receipt = {
      version: 1,
      receiptId: 'receipt-a',
      attemptId: 'attempt-a',
      logicalOperationId: 'logical-a',
      attemptIndex: 1,
      outcome: 'success',
      completedAt: LATER,
      recordedAt: LATER,
    };
  });

  it('does not poll hosted receipts for a proven local missing-link refusal', async () => {
    usage.appendTerminal({
      attemptId: 'attempt-a',
      logicalOperationId: 'logical-a',
      owner: OWNER,
      providerInstanceId: provider.instanceId,
      operationRevisionId: 'revision-a',
      outcome: 'error',
      errorCode: 'MANAGED_LINK_REQUIRED',
      recordedAt: LATER,
      provenance: 'broker',
    });
    const lookup = vi.fn();
    const service = new ManagedUsageMirrorService({
      db,
      cloud: { getManagedConnectorExecutionReceipt: lookup },
    });
    expect(await service.recover(100, new AbortController().signal)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(db.select().from(connectorManagedReceiptRecoveries).all()).toHaveLength(0);
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toMatchObject([
      { outcome: 'error', errorCode: 'MANAGED_LINK_REQUIRED' },
    ]);
  });

  it('keeps hosted evidence separate from an existing local unknown receipt and deduplicates it', () => {
    usage.appendTerminal({
      attemptId: 'attempt-a',
      logicalOperationId: 'logical-a',
      owner: OWNER,
      providerInstanceId: provider.instanceId,
      operationRevisionId: 'revision-a',
      outcome: 'outcome_unknown',
      errorCode: 'MANAGED_EXECUTION_OUTCOME_UNKNOWN',
      recordedAt: LATER,
      provenance: 'broker',
    });
    const service = new ManagedUsageMirrorService({
      db,
      cloud: { getManagedConnectorExecutionReceipt: vi.fn() },
      now: () => new Date('2026-09-06T12:00:02.000Z'),
    });

    service.observe(receipt);
    service.observe(receipt);

    expect(db.select().from(connectorManagedUsageMirrors).all()).toEqual([
      expect.objectContaining({
        hostedReceiptId: 'receipt-a',
        attemptId: 'attempt-a',
        outcome: 'success',
        mirroredAt: '2026-09-06T12:00:02.000Z',
      }),
    ]);
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toEqual([
      expect.objectContaining({
        attemptId: 'attempt-a',
        outcome: 'outcome_unknown',
        provenance: 'broker',
      }),
    ]);
  });

  it('refuses foreign, mismatched, and conflicting receipt evidence', () => {
    const service = new ManagedUsageMirrorService({
      db,
      cloud: { getManagedConnectorExecutionReceipt: vi.fn() },
    });

    expect(() => service.observe({ ...receipt, attemptId: 'missing' })).toThrowError(
      ManagedUsageMirrorError
    );
    expect(() => service.observe({ ...receipt, logicalOperationId: 'other' })).toThrowError(
      expect.objectContaining({ code: 'intent_mismatch' })
    );
    service.observe(receipt);
    expect(() =>
      service.observe({ ...receipt, outcome: 'error', errorCode: 'FAILED' })
    ).toThrowError(expect.objectContaining({ code: 'receipt_conflict' }));
  });

  it('recovers only recorded receipts without redispatch and contains lookup failures', async () => {
    const failures: string[] = [];
    const getManagedConnectorExecutionReceipt = vi
      .fn()
      .mockResolvedValueOnce({ state: 'recorded', receipt });
    const service = new ManagedUsageMirrorService({
      db,
      cloud: { getManagedConnectorExecutionReceipt },
      onRecoveryError: (attemptId) => failures.push(attemptId),
    });

    await expect(service.recover(25, new AbortController().signal)).resolves.toBe(1);
    expect(getManagedConnectorExecutionReceipt).toHaveBeenCalledWith(
      'attempt-a',
      expect.any(AbortSignal)
    );
    expect(db.select().from(connectorManagedUsageMirrors).all()).toHaveLength(1);
    await expect(service.recover(25, new AbortController().signal)).resolves.toBe(0);
    expect(getManagedConnectorExecutionReceipt).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  });

  it('durably defers an unavailable page so a later recoverable receipt is not starved', async () => {
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, '0');
      recordManagedIntent(`attempt-${suffix}`, `logical-${suffix}`);
    }
    const lookup = vi.fn(async (attemptId: string) =>
      attemptId === receipt.attemptId
        ? { state: 'recorded' as const, receipt }
        : { state: 'pending' as const, attemptId }
    );
    const firstProcess = new ManagedUsageMirrorService({
      db,
      cloud: { getManagedConnectorExecutionReceipt: lookup },
      now: () => new Date(NOW),
    });

    await expect(firstProcess.recover(100, new AbortController().signal)).resolves.toBe(0);
    expect(lookup).toHaveBeenCalledTimes(100);
    expect(lookup).not.toHaveBeenCalledWith('attempt-a', expect.any(AbortSignal));
    expect(db.select().from(connectorManagedReceiptRecoveries).all()).toHaveLength(100);

    const restarted = new ManagedUsageMirrorService({
      db,
      cloud: { getManagedConnectorExecutionReceipt: lookup },
      now: () => new Date(NOW),
    });
    await expect(restarted.recover(100, new AbortController().signal)).resolves.toBe(1);
    expect(lookup).toHaveBeenCalledWith('attempt-a', expect.any(AbortSignal));
    expect(db.select().from(connectorManagedUsageMirrors).all()).toMatchObject([
      { attemptId: 'attempt-a', hostedReceiptId: 'receipt-a' },
    ]);
  });
});
