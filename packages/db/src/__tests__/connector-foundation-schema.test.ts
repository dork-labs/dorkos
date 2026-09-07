import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorEventInbox,
  connectorEventReceipts,
  connectorEventSubscriptions,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  createDb,
  eq,
  runMigrations,
} from '../index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function now(): string {
  return '2026-09-05T00:00:00.000Z';
}

function seedProvider(db: ReturnType<typeof createDb>, id: string): void {
  db.insert(connectorProviderInstances)
    .values({
      id,
      type: 'composio',
      mode: 'byo',
      displayName: id,
      custody: 'managed',
      capabilityJson: '{}',
      status: 'available',
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function seedConnection(db: ReturnType<typeof createDb>, id: string, instanceId: string): void {
  db.insert(connections)
    .values({
      id,
      providerInstanceId: instanceId,
      externalAccountRef: 'same-upstream-account',
      toolkit: 'gmail',
      label: id,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function indexColumns(db: ReturnType<typeof createDb>, indexName: string): string[] {
  return db.$client
    .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
    .all(indexName)
    .map((column) => (column as { name: string }).name);
}

describe('connector foundation schema', () => {
  it('scopes private external references to a provider instance', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    seedProvider(db, 'instance-a');
    seedProvider(db, 'instance-b');
    seedConnection(db, 'connection-a', 'instance-a');
    seedConnection(db, 'connection-b', 'instance-b');

    expect(db.select().from(connections).all()).toHaveLength(2);
    expect(() => seedConnection(db, 'connection-c', 'instance-a')).toThrow();
    db.$client.close();
  });

  it('treats classification and retry policy as revision fingerprint fields', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    seedProvider(db, 'instance-a');
    const base = {
      providerInstanceId: 'instance-a',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.list',
      toolkitVersion: 'v1',
      schemaHash: 'hash-1',
      inputSchemaJson: '{"type":"object"}',
      discoveredAt: now(),
    } as const;
    db.insert(connectorOperationRevisions)
      .values({ id: 'revision-read', ...base, capabilityClassification: 'read' })
      .run();
    db.insert(connectorOperationRevisions)
      .values({ id: 'revision-write', ...base, capabilityClassification: 'write' })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-read-retryable',
        ...base,
        capabilityClassification: 'read',
        retryPolicy: 'provider_idempotency_key',
      })
      .run();

    expect(() =>
      db
        .update(connectorOperationRevisions)
        .set({ capabilityClassification: 'destructive' })
        .where(eq(connectorOperationRevisions.id, 'revision-read'))
        .run()
    ).toThrow(/immutable/i);
    expect(() =>
      db
        .delete(connectorOperationRevisions)
        .where(eq(connectorOperationRevisions.id, 'revision-read'))
        .run()
    ).toThrow(/immutable/i);
    db.$client.close();
  });

  it('indexes the exact durable reconciliation and audit lookup paths', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    expect(indexColumns(db, 'connection_operation_grants_connection_revision_idx')).toEqual([
      'connection_id',
      'operation_revision_id',
    ]);
    expect(indexColumns(db, 'connector_event_inbox_claim_idx')).toEqual([
      'provider_instance_id',
      'state',
      'next_attempt_at',
      'leased_until',
      'expires_at',
    ]);
    expect(indexColumns(db, 'connector_event_receipts_subscription_event_idx')).toEqual([
      'subscription_id',
      'provider_event_id',
    ]);
    expect(indexColumns(db, 'connector_agent_requests_resume_idx')).toEqual([
      'resume_state',
      'session_id',
      'service_slug',
    ]);
    expect(indexColumns(db, 'connector_usage_revision_started_idx')).toEqual([
      'operation_revision_id',
      'started_at',
    ]);
    db.$client.close();
  });

  it('binds grants and usage to the exact immutable revision', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    seedProvider(db, 'instance-a');
    seedConnection(db, 'connection-a', 'instance-a');
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: 'instance-a',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: 'v1',
        schemaHash: 'hash-1',
        capabilityClassification: 'read',
        inputSchemaJson: '{}',
        discoveredAt: now(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-a',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator-a',
        createdAt: now(),
      })
      .run();
    db.insert(connectorUsageAttempts)
      .values({
        attemptId: 'attempt-a',
        logicalOperationId: 'logical-a',
        attemptIndex: 0,
        surface: 'mcp',
        actorKind: 'agent',
        actorId: 'agent-a',
        ownerKind: 'local_install',
        ownerId: 'installation-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        providerInstanceId: 'instance-a',
        providerType: 'composio',
        payer: 'operator_byo',
        operationRevisionId: 'revision-a',
        startedAt: now(),
      })
      .run();
    db.insert(connectorUsageTerminalReceipts)
      .values({
        receiptId: 'receipt-a',
        attemptId: 'attempt-a',
        outcome: 'success',
        completedAt: now(),
        recordedAt: now(),
        provenance: 'broker',
      })
      .run();
    expect(() =>
      db
        .insert(connectionOperationGrants)
        .values({
          id: 'bad-grant',
          subjectType: 'agent',
          subjectId: 'agent-a',
          connectionId: 'connection-a',
          operationRevisionId: 'missing-revision',
          createdBy: 'operator-a',
          createdAt: now(),
        })
        .run()
    ).toThrow();
    expect(() =>
      db
        .update(connectorUsageAttempts)
        .set({ actorId: 'rewritten' })
        .where(eq(connectorUsageAttempts.attemptId, 'attempt-a'))
        .run()
    ).toThrow(/append-only/i);
    expect(() =>
      db
        .update(connectorUsageTerminalReceipts)
        .set({ outcome: 'error' })
        .where(eq(connectorUsageTerminalReceipts.attemptId, 'attempt-a'))
        .run()
    ).toThrow(/append-only/i);
    expect(() =>
      db
        .delete(connectorUsageTerminalReceipts)
        .where(eq(connectorUsageTerminalReceipts.attemptId, 'attempt-a'))
        .run()
    ).toThrow(/append-only/i);
    expect(() =>
      db
        .delete(connectorUsageAttempts)
        .where(eq(connectorUsageAttempts.attemptId, 'attempt-a'))
        .run()
    ).toThrow(/append-only/i);
    expect(() => db.delete(connections).where(eq(connections.id, 'connection-a')).run()).toThrow(
      /tombstoned/i
    );
    db.$client.close();
  });

  it('keeps protected inbox retry and lease state across a database reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dorkos-connector-inbox-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'dork.db');
    const db = createDb(dbPath);
    runMigrations(db);
    seedProvider(db, 'instance-a');
    seedConnection(db, 'connection-a', 'instance-a');
    db.insert(connectorEventSubscriptions)
      .values({
        id: 'subscription-a',
        connectionId: 'connection-a',
        agentId: 'agent-a',
        destinationKind: 'agent',
        destinationId: 'agent-a',
        eventType: 'new_message',
        filterJson: '{}',
        filterHash: 'filter-a',
        deliveryMode: 'turn',
        createdBy: 'operator-a',
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    const inbox = {
      id: 'inbox-a',
      providerInstanceId: 'instance-a',
      subscriptionId: 'subscription-a',
      providerEventId: 'provider-event-a',
      payloadSchemaVersion: 1,
      normalizedPayload: 'encrypted:v1:ciphertext',
      payloadProtection: 'encrypted' as const,
      state: 'leased' as const,
      attemptCount: 2,
      nextAttemptAt: '2026-09-05T00:01:00.000Z',
      expiresAt: '2026-09-06T00:00:00.000Z',
      leaseOwner: 'worker-a',
      leasedUntil: '2026-09-05T00:00:30.000Z',
      receivedAt: now(),
    };
    db.insert(connectorEventInbox).values(inbox).run();
    db.insert(connectorEventReceipts)
      .values({
        id: 'receipt-a',
        inboxId: 'inbox-a',
        subscriptionId: 'subscription-a',
        providerEventId: 'provider-event-a',
        state: 'leased',
        recordedAt: now(),
      })
      .run();
    db.$client.close();

    const reopened = createDb(dbPath);
    runMigrations(reopened);
    expect(reopened.select().from(connectorEventInbox).get()).toMatchObject(inbox);
    expect(() =>
      reopened
        .insert(connectorEventInbox)
        .values({ ...inbox, id: 'inbox-b' })
        .run()
    ).toThrow();
    const receiptColumns = reopened.$client
      .prepare('PRAGMA table_info(connector_event_receipts)')
      .all()
      .map((column) => (column as { name: string }).name);
    expect(receiptColumns).not.toContain('normalized_payload');
    expect(() =>
      reopened
        .update(connectorEventReceipts)
        .set({ state: 'rewritten' })
        .where(eq(connectorEventReceipts.id, 'receipt-a'))
        .run()
    ).toThrow(/append-only/i);
    expect(() =>
      reopened
        .delete(connectorEventReceipts)
        .where(eq(connectorEventReceipts.id, 'receipt-a'))
        .run()
    ).toThrow(/append-only/i);
    reopened.$client.close();
  });
});
