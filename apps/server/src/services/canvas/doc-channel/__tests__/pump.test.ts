/** Real SQLite lease, wait and correlated receipt scheduling without paid runtimes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sql,
  createDb,
  eq,
  canvasDocBatches,
  canvasDocEvents,
  canvasDocGrants,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { batchFixture, NOW, type BatchFixture } from './batch-fixtures.js';
import {
  DocBatchDeliveryPump,
  type DocBatchPumpOptions,
  type DocPumpObservation,
} from '../delivery/pump.js';
import { retainDocHistory } from '../retention.js';
// Synchronous transaction ports reject async callbacks at the declaration boundary too.
const invalidAsyncGates: Pick<DocBatchPumpOptions, 'capacity' | 'budget' | 'markWaitingWarning'> = {
  // @ts-expect-error Final capacity gates must return their decision synchronously.
  capacity: async () => ({ available: true }),
  // @ts-expect-error Final platform budget gates cannot return a Promise.
  budget: async () => ({ available: true }),
  // @ts-expect-error Atomic warning markers must commit synchronously.
  markWaitingWarning: async () => true,
};
void invalidAsyncGates;
const databases: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(file = ':memory:') {
  let time = Date.parse(NOW);
  const now = () => new Date(time);
  const f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', now);
  databases.push(f.db);
  f.db.$client.exec(
    'CREATE TABLE IF NOT EXISTS fixture_doc_warning (batch_id TEXT, generation TEXT, warned_at TEXT, PRIMARY KEY(batch_id,generation))'
  );
  const nudge = vi.fn(() => undefined);
  const observations: DocPumpObservation[] = [];
  const options: DocBatchPumpOptions = {
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now,
    capacity: () => ({ available: true }),
    budget: () => ({ available: true }),
    nudge,
    observe: (event) => {
      observations.push(event);
      return undefined;
    },
    markWaitingWarning: (batchId, generation, at, tx) =>
      tx.run(sql`INSERT OR IGNORE INTO fixture_doc_warning VALUES (${batchId},${generation},${at})`)
        .changes === 1,
  };
  return {
    f,
    options,
    nudge,
    observations,
    advance: (ms: number) => {
      time += ms;
    },
    pump: () => new DocBatchDeliveryPump(options),
  };
}
function receipt(f: BatchFixture) {
  return f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
}
async function complete(f: BatchFixture, id: string, outcome: 'ok' | 'failed' = 'ok') {
  const prepared = await f.admission.acceptance.prepare(id);
  f.admission.acceptance.claim(id, prepared);
  f.admission.acceptance.markTurnStarted(id, 3);
  f.admission.acceptance.settle(id, outcome);
}
describe('durable document delivery pump', () => {
  it('leases one due generation for two pumps and nudges only committed acceptance', () => {
    const h = setup();
    h.f.input();
    expect(h.pump().run().admitted).toBe(0);
    h.advance(1001);
    expect(h.pump().run().admitted).toBe(1);
    expect(h.pump().run().admitted).toBe(0);
    expect(h.nudge).toHaveBeenCalledExactlyOnceWith('session-1', [receipt(h.f).id]);
    expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
    expect(h.f.store.getBatch(receipt(h.f).sourceId)?.attempt).toBe(1);
  });
  it('honors an existing durable lease until expiry, then admits its original generation', () => {
    const h = setup();
    h.f.input();
    h.advance(1001);
    const original = h.f.store.getBatch(h.f.batchId())!;
    h.f.store.acquireLease({
      batchId: original.batchId,
      generation: original.generation,
      status: 'pending',
      now: h.options.now().toISOString(),
      leaseUntil: new Date(h.options.now().getTime() + 30000).toISOString(),
    });
    expect(h.pump().run().admitted).toBe(0);
    h.advance(30001);
    expect(h.pump().run().admitted).toBe(1);
    expect(receipt(h.f).sourceGeneration).toBe(original.generation);
  });
  it('persists platform budget waits outside slots and emits a warning once across pruning and restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-warning-restart-'));
    directories.push(directory);
    const file = join(directory, 'state.db');
    const h = setup(file);
    h.f.input();
    h.advance(15 * 60000);
    h.options.budget = () => ({
      available: false,
      reason: 'platform_budget',
      nextEligibleAt: new Date(h.options.now().getTime() + 60000).toISOString(),
    });
    h.options.capacity = vi.fn(() => ({ available: true as const }));
    expect(h.pump().run().waiting).toBe(1);
    expect(h.observations.filter((event) => event.outcome === 'warning')).toHaveLength(1);
    expect(h.options.capacity).not.toHaveBeenCalled();
    expect(h.nudge).not.toHaveBeenCalled();
    expect(h.f.db.select().from(sessionMessageQueue).all()).toEqual([]);
    // Status retention cannot erase the independent durable warning marker.
    h.f.db.delete(canvasDocEvents).where(eq(canvasDocEvents.direction, 'system')).run();
    databases.pop();
    h.f.db.$client.close();
    const db = createDb(file);
    databases.push(db);
    const reboot = batchFixture(
      file,
      null,
      { db, documentId: h.f.documentId, grantId: h.f.grantId },
      'boot-2',
      'claude-code',
      h.options.now
    );
    Object.assign(h.options, {
      db,
      store: reboot.store,
      grants: reboot.grants,
      admission: reboot.admission,
    });
    h.advance(60001);
    expect(h.pump().run().waiting).toBe(1);
    expect(h.observations.filter((event) => event.outcome === 'warning')).toHaveLength(1);
    expect(h.pump().run().waiting).toBe(0);
  });
  it('expires old unadmitted work with explicit replay and no receipt/runtime nudge', () => {
    const h = setup();
    h.f.input();
    h.f.db
      .update(canvasDocBatches)
      .set({ dueAt: new Date(Date.parse(NOW) - 24 * 3600000 + 1000).toISOString() })
      .run();
    expect(h.pump().run().expired).toBe(1);
    expect(
      h.f.store.getBatch(h.f.db.select().from(canvasDocBatches).all()[0]!.batchId)?.status
    ).toBe('expired');
    expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
    expect(h.nudge).not.toHaveBeenCalled();
    const status = h.f.db
      .select()
      .from(canvasDocEvents)
      .all()
      .find(
        (event) =>
          event.type === 'event.status' &&
          (event.payload as { status?: string }).status === 'expired'
      );
    expect(status?.payload).toMatchObject({ replayAvailable: true });
  });
  it('keeps bounded overflow pending until correlated successful completion frees its route', async () => {
    const h = setup();
    for (let i = 0; i < 8; i++) h.f.input({ text: 'x'.repeat(15000) });
    h.advance(1001);
    expect(h.pump().run().admitted).toBe(1);
    const first = receipt(h.f);
    const batch = h.f.store.getBatch(first.sourceId)!;
    const overflow = h.f.store.getBatch(h.f.batchId())!;
    expect(overflow.dueAt).toBe(batch.dueAt);
    expect(overflow.inputEventIds.length).toBeGreaterThan(0);
    expect(h.pump().run().waiting).toBe(1);
    await complete(h.f, first.id);
    h.advance(60001);
    expect(h.pump().run().admitted).toBe(1);
    const rows = h.f.db.select().from(sessionMessageAcceptanceReceipts).all();
    expect(rows).toHaveLength(2);
    expect(h.f.store.getBatch(first.sourceId)?.turnId).toBe(`projected:${first.id}:3`);
    expect(h.f.store.getBatch(first.sourceId)?.status).toBe('turn_done');
  });
  it('enforces the rolling started-turn ceiling and retains its evidence under pruning', async () => {
    const h = setup();
    for (let i = 0; i < 10; i++) {
      h.f.input();
      h.advance(1001);
      expect(h.pump().run().admitted).toBe(1);
      const current = h.f.db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .all()
        .find((row) => row.state === 'accepted')!;
      await complete(h.f, current.id);
    }
    retainDocHistory(h.f.store, h.options.now().toISOString(), {
      documentBytes: 1,
      installationBytes: 1,
    });
    h.f.input();
    h.advance(1001);
    expect(h.pump().run().waiting).toBe(1);
    expect(h.observations.at(-1)).toMatchObject({
      outcome: 'waiting',
      reason: 'route_turn_ceiling',
    });
    expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(10);
    h.advance(3600000);
    retainDocHistory(h.f.store, h.options.now().toISOString(), {
      documentBytes: 1,
      installationBytes: 1,
    });
    expect(
      h.f.db
        .select()
        .from(canvasDocBatches)
        .all()
        .filter((batch) => batch.status === 'turn_done')
    ).toEqual([]);
    expect(h.pump().run().admitted).toBe(1);
  });
  it.each(['capacity', 'budget', 'markWaitingWarning'] as const)(
    'rejects async %s and retires captured late SQLite writes',
    async (hook) => {
      const h = setup();
      h.f.input();
      h.advance(16 * 60000);
      let lateRefused = false;
      if (hook === 'markWaitingWarning')
        h.options.capacity = () => ({
          available: false,
          reason: 'busy',
          nextEligibleAt: new Date(h.options.now().getTime() + 60000).toISOString(),
        });
      const asyncHook = async (...args: unknown[]) => {
        const tx = args.at(-1) as DbTransaction;
        const run = tx.update(canvasDocGrants).set({ revokedAt: NOW }).run;
        await Promise.resolve();
        try {
          run();
        } catch {
          lateRefused = true;
        }
        throw new Error('late refusal');
      };
      (h.options as unknown as Record<string, unknown>)[hook] = asyncHook;
      expect(h.pump().run().waiting).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(lateRefused).toBe(true);
      expect(h.f.store.getGrant(h.f.grantId)?.revokedAt).toBeNull();
      expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
      expect(h.f.db.select().from(sessionMessageQueue).all()).toEqual([]);
    }
  );
  it('requires explicit authenticated replay, preserves original inputs and refuses duplicate replay', () => {
    const h = setup();
    h.f.input();
    const old = h.f.store.getBatch(h.f.batchId())!;
    h.f.db
      .update(canvasDocBatches)
      .set({ dueAt: new Date(Date.parse(NOW) - 24 * 3600000 + 1000).toISOString() })
      .run();
    expect(h.pump().run().expired).toBe(1);
    const next = h.pump().replayExpired(old.batchId, h.f.grantId, h.f.actor);
    expect(h.f.store.getBatch(next)).toMatchObject({
      status: 'pending',
      inputEventIds: old.inputEventIds,
    });
    expect(h.f.store.getBatch(next)?.generation).not.toBe(old.generation);
    expect(() => h.pump().replayExpired(old.batchId, h.f.grantId, h.f.actor)).toThrow();
    expect(h.pump().run().admitted).toBe(1);
    expect(h.observations.some((event) => event.outcome === 'replayed')).toBe(true);
  });
  it('refuses replay whose retained input was pruned instead of dropping it', () => {
    const h = setup();
    h.f.input();
    const id = h.f.batchId();
    h.f.db
      .update(canvasDocBatches)
      .set({ dueAt: new Date(Date.parse(NOW) - 24 * 3600000 + 1000).toISOString() })
      .run();
    h.pump().run();
    h.f.db
      .update(canvasDocEvents)
      .set({ payload: sql`'null'`, payloadPrunedAt: NOW })
      .where(eq(canvasDocEvents.direction, 'upstream'))
      .run();
    expect(() => h.pump().replayExpired(id, h.f.grantId, h.f.actor)).toThrow();
    expect(h.f.db.select().from(canvasDocBatches).all()).toHaveLength(1);
  });
  it('caps long external waits at the warning and expiry boundaries even if the grant later expires', () => {
    const h = setup();
    h.f.input();
    h.advance(1001);
    h.options.capacity = () => ({
      available: false,
      reason: 'busy',
      nextEligibleAt: new Date(Date.parse(NOW) + 48 * 3600000).toISOString(),
    });
    expect(h.pump().run().nextEligibleAt).toBe(
      new Date(Date.parse(NOW) + 15 * 60000).toISOString()
    );
    h.advance(15 * 60000 - 1001);
    expect(h.pump().run().waiting).toBe(1);
    h.advance(24 * 3600000 - 15 * 60000);
    expect(h.pump().run().expired).toBe(1);
    expect(h.observations.filter((event) => event.outcome === 'warning')).toHaveLength(1);
  });
  it('refuses an uncorrelated forged source completion and keeps a claimed receipt unchanged', async () => {
    const h = setup();
    h.f.input();
    h.advance(1001);
    h.pump().run();
    const row = receipt(h.f);
    const prepared = await h.f.admission.acceptance.prepare(row.id);
    h.f.admission.acceptance.claim(row.id, prepared);
    h.f.admission.acceptance.markTurnStarted(row.id, 4);
    const started = receipt(h.f);
    expect(() =>
      h.f.store.transaction((tx) =>
        h.f.admission.source.onSettled(
          tx,
          { ...started, queueMessageId: 'unrelated-message' },
          'ok',
          NOW
        )
      )
    ).toThrow();
    expect(h.f.store.getBatch(row.sourceId)?.status).toBe('turn_started');
    expect(receipt(h.f).state).toBe('turn_started');
  });
  it('refuses revoked authority and keeps started failure terminal despite unrelated settlement', async () => {
    const h = setup();
    h.f.input();
    h.advance(1001);
    h.pump().run();
    const accepted = receipt(h.f);
    await complete(h.f, accepted.id, 'failed');
    h.f.admission.acceptance.settle('unrelated', 'ok');
    expect(h.f.store.getBatch(accepted.sourceId)?.status).toBe('failed');
    h.f.input();
    h.f.grants.revoke(h.f.documentId, h.f.grantId, h.f.actor);
    h.advance(1001);
    expect(h.pump().run().cancelled).toBe(1);
    expect(h.pump().run().admitted).toBe(0);
    expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
  });
});
