import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectorOperationRevisions,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../../registry.js';
import {
  ConnectorUsageEvidenceError,
  ConnectorUsageStore,
  type ConnectorUsageIntentInput,
} from '../usage-store.js';

const NOW = '2026-09-06T12:00:00.000Z';
const LATER = '2026-09-06T12:00:01.000Z';
const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

describe('ConnectorUsageStore', () => {
  let db: Db;
  let store: ConnectorUsageStore;
  let provider: FakeConnectorProvider;
  let connection: ConnectedAccount;
  let intent: ConnectorUsageIntentInput;

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    store = new ConnectorUsageStore(db);
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
    intent = {
      attemptId: 'attempt-a',
      logicalOperationId: 'logical-a',
      attemptIndex: 1,
      surface: 'mcp',
      actorKind: 'agent',
      actorId: 'agent-a',
      owner: OWNER,
      agentId: 'agent-a',
      sessionId: 'session-a',
      connectionId: connection.id,
      providerInstanceId: provider.instanceId,
      providerType: provider.type,
      payer: 'operator_byo',
      operationRevisionId: 'revision-a',
      startedAt: NOW,
    };
  });

  it('keeps intent immutable and appends terminal evidence separately', () => {
    store.recordIntent(intent);

    expect(db.select().from(connectorUsageAttempts).get()).toMatchObject({
      attemptId: 'attempt-a',
      ownerKind: 'local_install',
      ownerId: 'install-a',
    });
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toEqual([]);

    const receiptId = store.appendTerminal({
      attemptId: 'attempt-a',
      logicalOperationId: 'logical-a',
      owner: OWNER,
      providerInstanceId: provider.instanceId,
      operationRevisionId: 'revision-a',
      outcome: 'success',
      completedAt: LATER,
      recordedAt: LATER,
      provenance: 'broker',
    });

    expect(db.select().from(connectorUsageTerminalReceipts).get()).toMatchObject({
      receiptId,
      attemptId: 'attempt-a',
      outcome: 'success',
      completedAt: LATER,
      provenance: 'broker',
    });
  });

  it('deduplicates only an exact terminal receipt and refuses conflicts', () => {
    store.recordIntent(intent);
    const terminal = {
      attemptId: 'attempt-a',
      logicalOperationId: 'logical-a',
      owner: OWNER,
      providerInstanceId: provider.instanceId,
      operationRevisionId: 'revision-a',
      outcome: 'error' as const,
      errorCode: 'UPSTREAM_TIMEOUT',
      recordedAt: LATER,
      provenance: 'broker' as const,
    };

    const receiptId = store.appendTerminal(terminal);
    expect(store.appendTerminal(terminal)).toBe(receiptId);
    expect(() => store.appendTerminal({ ...terminal, outcome: 'success' })).toThrowError(
      expect.objectContaining<Partial<ConnectorUsageEvidenceError>>({ code: 'receipt_conflict' })
    );
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(1);
  });

  it('refuses terminal evidence from a different authority or dispatch target', () => {
    store.recordIntent(intent);
    const terminal = {
      attemptId: 'attempt-a',
      logicalOperationId: 'logical-a',
      owner: OWNER,
      providerInstanceId: provider.instanceId,
      operationRevisionId: 'revision-a',
      outcome: 'success' as const,
      recordedAt: LATER,
      provenance: 'broker' as const,
    };

    for (const mismatch of [
      { owner: { kind: 'local_install', installationId: 'install-b' } as const },
      { logicalOperationId: 'logical-b' },
      { providerInstanceId: 'provider-b' },
      { operationRevisionId: 'revision-b' },
    ]) {
      expect(() => store.appendTerminal({ ...terminal, ...mismatch })).toThrowError(
        expect.objectContaining<Partial<ConnectorUsageEvidenceError>>({ code: 'intent_mismatch' })
      );
    }
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(0);
  });

  it('closes pending intents as unknown after restart without replaying provider work', () => {
    const execute = vi.spyOn(provider, 'execute');
    store.recordIntent(intent);

    expect(store.recoverPending(LATER)).toBe(1);
    expect(store.recoverPending(LATER)).toBe(0);
    expect(
      db
        .select()
        .from(connectorUsageTerminalReceipts)
        .where(eq(connectorUsageTerminalReceipts.attemptId, 'attempt-a'))
        .get()
    ).toMatchObject({
      outcome: 'outcome_unknown',
      errorCode: 'SERVER_RESTARTED_AFTER_INTENT',
      completedAt: null,
      recordedAt: LATER,
      provenance: 'startup_recovery',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
