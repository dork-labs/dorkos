import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, sessionMessageAcceptanceReceipts, eq, type Db } from '@dorkos/db';
import { MessageQueueStore } from '../message-queue-store.js';
import { PrivateSessionMessageAcceptanceService } from '../private-messages/acceptance.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
let directory: string;
let filename: string;
let db: Db;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'private-unavailable-source-'));
  filename = join(directory, 'restart.sqlite');
  db = createDb(filename);
  runMigrations(db);
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

function seed(
  sourceKind: 'connector_event' | 'connector_agent_request',
  state: 'dispatching' | 'turn_started'
) {
  const queue = new MessageQueueStore(db);
  const message = queue.enqueue({
    id: 'private-placeholder',
    sessionId: 'session',
    content: '[Private connection update]',
    clientId: 'private-source',
  });
  const row = {
    id: 'receipt',
    sourceKind,
    sourceId: 'retained-source',
    sourceGeneration: 'immutable-generation',
    queueMessageId: message.id,
    sessionId: 'session',
    agentId: 'agent',
    originRuntime: 'claude-code',
    originAgentPath: '/agents/current',
    originAuthorityDigest: 'sha256:original-authority',
    state,
    acceptedAt: NOW.toISOString(),
    dispatchAttemptId: 'original-attempt',
    dispatchBootEpoch: 'previous-boot',
    dispatchClaimedAt: NOW.toISOString(),
    ...(state === 'turn_started' ? { turnStartSeq: 42, turnStartedAt: NOW.toISOString() } : {}),
  };
  db.insert(sessionMessageAcceptanceReceipts).values(row).run();
  return db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, row.id))
    .get()!;
}
function reopen() {
  db.$client.close();
  db = createDb(filename);
}
function recovery() {
  return new PrivateSessionMessageAcceptanceService(
    db,
    new MessageQueueStore(db),
    [],
    'degraded-new-boot',
    () => NOW
  );
}

describe('restart quarantine when construction-failure degradation omits a fixed private source', () => {
  for (const kind of ['connector_event', 'connector_agent_request'] as const) {
    it.each(['dispatching', 'turn_started'] as const)(
      `${kind} %s retains durable identity without an unavailable adapter`,
      (state) => {
        const original = seed(kind, state);
        reopen();
        const service = recovery();
        expect(service.recoverUnobservedAttempts()).toBe(1);
        expect(new MessageQueueStore(db).list('session')).toEqual([]);
        const quarantined = service.findByQueueMessageId(original.queueMessageId)!;
        expect(quarantined).toEqual({
          ...original,
          state: 'outcome_unknown',
          cancellationCode: 'server_restarted_after_dispatch_claim',
          settledAt: NOW.toISOString(),
        });
        expect(service.recoverUnobservedAttempts()).toBe(0);
        reopen();
        expect(recovery().findByQueueMessageId(original.queueMessageId)).toEqual(quarantined);
        expect(recovery().recoverUnobservedAttempts()).toBe(0);
        expect(new MessageQueueStore(db).list('session')).toEqual([]);
      }
    );
  }
  it('rolls queue removal back if durable quarantine cannot be written', () => {
    const original = seed('connector_event', 'dispatching');
    reopen();
    db.$client.exec(
      "CREATE TRIGGER refuse_quarantine BEFORE UPDATE ON session_message_acceptance_receipts BEGIN SELECT RAISE(ABORT, 'quarantine write failed'); END"
    );
    expect(() => recovery().recoverUnobservedAttempts()).toThrow('quarantine write failed');
    expect(recovery().findByQueueMessageId(original.queueMessageId)).toEqual(original);
    expect(new MessageQueueStore(db).get(original.queueMessageId)).toBeDefined();
    db.$client.exec('DROP TRIGGER refuse_quarantine');
    expect(recovery().recoverUnobservedAttempts()).toBe(1);
    expect(new MessageQueueStore(db).get(original.queueMessageId)).toBeUndefined();
  });
  it("does not quarantine an accepted unclaimed row or this boot's dispatch claim", () => {
    seed('connector_event', 'dispatching');
    db.update(sessionMessageAcceptanceReceipts)
      .set({ dispatchBootEpoch: 'degraded-new-boot' })
      .run();
    expect(recovery().recoverUnobservedAttempts()).toBe(0);
    db.update(sessionMessageAcceptanceReceipts)
      .set({ state: 'accepted', dispatchBootEpoch: null })
      .run();
    expect(recovery().recoverUnobservedAttempts()).toBe(0);
    expect(new MessageQueueStore(db).get('private-placeholder')).toBeDefined();
  });
});
