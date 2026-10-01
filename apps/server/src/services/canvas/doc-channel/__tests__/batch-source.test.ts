import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canvasDocBatches,
  canvasDocGrants,
  canvasDocIdentityIntents,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  createDb,
  eq,
  type Db,
} from '@dorkos/db';
import { batchFixture, FROM, TO, NOW } from './batch-fixtures.js';
import { DocRouteGrantError } from '../grant-policy.js';
import type { PrivateSessionMessageSourceAdapter } from '../../../session/private-messages/acceptance.js';
import { renderDocEvents, docEventsPromptBytes } from '../prompt.js';
// The new final hooks cannot type-check an async function as a void callback.
const synchronousHooks: Pick<PrivateSessionMessageSourceAdapter, 'onAccepted' | 'revalidate'> = {
  // @ts-expect-error Async acceptance must be rejected by the public typed contract.
  onAccepted: async () => {},
  // @ts-expect-error Async final authorization must be rejected by the public typed contract.
  revalidate: async () => {},
};
void synchronousHooks;
const databases: Db[] = [];
const dirs: string[] = [];
function fixture() {
  const f = batchFixture();
  databases.push(f.db);
  f.input();
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.$client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const queueSession = (db: Db, id: string) =>
  db.select().from(sessionMessageQueue).where(eq(sessionMessageQueue.id, id)).get()?.sessionId;
const receipts = (db: Db) => db.select().from(sessionMessageAcceptanceReceipts).all();
describe('fixed owning-session document source', () => {
  it('links one immutable source/receipt/neutral queue and exclusively claims under competing dispatchers', async () => {
    const f = fixture();
    const batch = f.batchId();
    const accepted = f.admission.admit(batch);
    expect(accepted.queueRecord?.content).toBe('[Document update]');
    expect(JSON.stringify(f.db.select().from(sessionMessageQueue).all())).not.toContain('checked');
    expect(f.store.getBatch(batch)?.admissionReceiptId).toBe(accepted.receipt.id);
    expect(
      f.store.listDeliveries(f.documentId, f.store.getBatch(batch)!.inputEventIds[0]!)[0]?.status
    ).toBe('routed');
    expect(f.admission.admit(batch).receipt.id).toBe(accepted.receipt.id);
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        Promise.resolve().then(() => f.admission.acceptance.claim(accepted.receipt.id, prepared))
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const result = results.find((r) => r.status === 'fulfilled');
    if (result?.status !== 'fulfilled') throw new Error('claim');
    expect(result.value.docEvents?.events[0]?.payload).toEqual({ checked: true });
    expect(f.admission.source.sender(accepted.receipt)).toBe(`relay.doc.${f.documentId}`);
    f.admission.acceptance.markTurnStarted(accepted.receipt.id, 42);
    f.admission.acceptance.settle(accepted.receipt.id, 'ok');
    expect(f.store.getBatch(batch)?.status).toBe('turn_done');
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeUndefined();
  });
  it('refuses revoked authority after prepare with zero claim effects', async () => {
    const f = fixture();
    const accepted = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    f.grants.revoke(f.documentId, f.grantId, f.actor);
    expect(() => f.admission.acceptance.claim(accepted.receipt.id, prepared)).toThrow(
      'GRANT_REVOKED'
    );
    expect(receipts(f.db)[0]?.state).toBe('accepted');
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('accepted');
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
  });
  it('rejects mutated immutable inputs and forged prepared data at the final source check', async () => {
    const f = fixture();
    const accepted = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    prepared.docEvents!.scope = 'session:attacker';
    prepared.docEvents!.events[0]!.payload = { checked: false };
    const claimed = f.admission.acceptance.claim(accepted.receipt.id, prepared);
    expect(claimed.docEvents?.scope).toBe(FROM);
    expect(claimed.docEvents?.events[0]?.payload).toEqual({ checked: true });
    const g = fixture();
    const other = g.admission.admit(g.batchId());
    const snapshot = await g.admission.acceptance.prepare(other.receipt.id);
    g.db
      .update(canvasDocBatches)
      .set({ inputEventIds: [] })
      .where(eq(canvasDocBatches.batchId, other.receipt.sourceId))
      .run();
    expect(() => g.admission.acceptance.claim(other.receipt.id, snapshot)).toThrow();
    expect(receipts(g.db)[0]?.state).toBe('accepted');
  });
  it('rolls back selected inputs, receipt and queue when linking fails', () => {
    const f = fixture();
    const batch = f.batchId();
    vi.spyOn(f.admission.source, 'onAccepted').mockImplementation(() => {
      throw new Error('link failed');
    });
    expect(() => f.admission.admit(batch)).toThrow('link failed');
    expect(receipts(f.db)).toEqual([]);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(f.store.getBatch(batch)?.status).toBe('pending');
    expect(f.store.getBatch(batch)?.admissionReceiptId).toBeNull();
  });
  it('rebinds actual grant authority and restarts the original accepted receipt in one canonical session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-batch-restart-'));
    dirs.push(dir);
    const file = join(dir, 'state.db');
    const f = batchFixture(file);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const before = await f.admission.acceptance.prepare(accepted.receipt.id);
    expect(f.documents.rekeyScope(FROM, TO)).toBe(1);
    expect(f.store.getBatch(accepted.receipt.sourceId)?.generation).toBe(
      accepted.receipt.sourceGeneration
    );
    const moved = receipts(f.db)[0]!;
    expect(moved.id).toBe(accepted.receipt.id);
    expect(moved.sessionId).toBe('canonical');
    expect(moved.originAgentPath).toBe('/agents/one');
    expect(moved.originAuthorityDigest).not.toBe(accepted.receipt.originAuthorityDigest);
    expect(queueSession(f.db, moved.queueMessageId)).toBe('canonical');
    expect(f.admission.acceptance.listAccepted('session-1')).toEqual([]);
    // A prepared snapshot from before rekey is replaced by fresh canonical context.
    expect(before.docEvents?.scope).toBe(FROM);
    f.db.$client.close();
    const db = createDb(file);
    databases.push(db);
    const reboot = batchFixture(
      file,
      null,
      { db, documentId: f.documentId, grantId: f.grantId },
      'boot-2'
    );
    const prepared = await reboot.admission.acceptance.prepare(moved.id);
    const claimed = reboot.admission.acceptance.claim(moved.id, prepared);
    expect(claimed.docEvents?.scope).toBe(TO);
    expect(receipts(db)).toHaveLength(1);
    expect(() => reboot.admission.acceptance.claim(moved.id, prepared)).toThrow(
      'no longer available'
    );
  });
  it('rebinds accepted work before committing mixed claimed-work quarantine without repeating the uncertain source', async () => {
    const f = batchFixture();
    databases.push(f.db);
    const route = {
      on: 'task.*',
      to: 'agent:owner' as const,
      turn: { mode: 'coalesce' as const, windowMs: 1000, maxBatch: 100 },
    };
    f.grants.configure(
      f.documentId,
      {
        routes: [
          { id: 'route', ...route },
          { id: 'second', ...route },
        ],
      },
      f.actor
    );
    for (const routeId of ['route', 'second'])
      f.grants.grant(
        { documentId: f.documentId, routeId, expiresAt: '2026-10-02T00:00:00.000Z' },
        f.actor
      );
    f.input();
    const batches = f.db.select().from(canvasDocBatches).all();
    const first = f.admission.admit(batches[0]!.batchId);
    const second = f.admission.admit(batches[1]!.batchId);
    const prepared = await f.admission.acceptance.prepare(first.receipt.id);
    f.admission.acceptance.claim(first.receipt.id, prepared);
    expect(f.documents.rekeyScope(FROM, TO)).toBe(1);
    expect(f.store.getBatch(first.receipt.sourceId)?.status).toBe('in_doubt');
    expect(receipts(f.db).find((r) => r.id === first.receipt.id)?.sessionId).toBe('session-1');
    expect(receipts(f.db).find((r) => r.id === second.receipt.id)?.sessionId).toBe('canonical');
    expect(f.store.getBatch(second.receipt.sourceId)?.status).toBe('accepted');
    expect(f.documents.lifecycle.health(f.documentId).status).toBe('in_doubt');
    expect(f.db.select().from(canvasDocIdentityIntents).all()[0]?.status).toBe('in_doubt');
    await expect(f.admission.acceptance.prepare(second.receipt.id)).rejects.toThrow(
      'ownership move needs recovery'
    );
  });
  it('rolls every ownership row back when actual grant authority refuses mid-rebind', () => {
    const f = fixture();
    const accepted = f.admission.admit(f.batchId());
    const real = f.grants.revalidateBatchGrant.bind(f.grants);
    vi.spyOn(f.grants, 'revalidateBatchGrant').mockImplementation((batch, tx) => {
      if (batch.scope === TO) throw new DocRouteGrantError('ORIGIN_AUTHORITY_LOST');
      return real(batch, tx);
    });
    expect(() => f.documents.rekeyScope(FROM, TO)).toThrow('ORIGIN_AUTHORITY_LOST');
    expect(f.store.getChannel(f.documentId)?.scope).toBe(FROM);
    expect(f.store.getBatch(accepted.receipt.sourceId)?.scope).toBe(FROM);
    expect(f.store.getGrant(f.grantId)?.targetSessionId).toBe('session-1');
    expect(receipts(f.db)[0]).toEqual(accepted.receipt);
    expect(queueSession(f.db, accepted.receipt.queueMessageId)).toBe('session-1');
    expect(f.documents.get(FROM, f.documentId)).toBeDefined();
    expect(f.documents.get(TO, f.documentId)).toBeNull();
    expect(f.db.select().from(canvasDocIdentityIntents).all()[0]?.status).toBe('failed');
  });
  it('permanently revokes the exact observed manifest grant after rebind rollback even when old bytes return', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-rebind-manifest-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.dork'));
    const file = join(dir, '.dork/app.json');
    const old = JSON.stringify({ v: 1, types: { 'task.toggle': { type: 'object' } } });
    writeFileSync(file, old);
    const f = batchFixture(':memory:', dir);
    databases.push(f.db);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const real = f.grants.revalidateBatchGrant.bind(f.grants);
    vi.spyOn(f.grants, 'revalidateBatchGrant').mockImplementation((batch, tx) => {
      if (batch.scope === TO) writeFileSync(file, JSON.stringify({ v: 1, types: {} }));
      return real(batch, tx);
    });
    expect(() => f.documents.rekeyScope(FROM, TO)).toThrow('authority changed');
    expect(f.store.getChannel(f.documentId)?.scope).toBe(FROM);
    expect(f.store.getBatch(accepted.receipt.sourceId)?.scope).toBe(FROM);
    expect(receipts(f.db)[0]).toEqual(accepted.receipt);
    expect(queueSession(f.db, accepted.receipt.queueMessageId)).toBe('session-1');
    expect(f.store.getGrant(f.grantId)?.revokedAt).not.toBeNull();
    writeFileSync(file, old);
    vi.restoreAllMocks();
    f.documents.lifecycle.recoverIdentityMoves();
    expect(f.store.getGrant(f.grantId)?.revokedAt).not.toBeNull();
    expect(() => f.admission.admit(accepted.receipt.sourceId)).toThrow(
      'ownership move needs recovery'
    );
  });
  it('commits exact manifest suspension when the app changes after prepare but before the final claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-claim-manifest-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.dork'));
    const file = join(dir, '.dork/app.json');
    const old = JSON.stringify({ v: 1, types: { 'task.toggle': { type: 'object' } } });
    writeFileSync(file, old);
    const f = batchFixture(':memory:', dir);
    databases.push(f.db);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    writeFileSync(file, JSON.stringify({ v: 1, types: {} }));
    expect(() => f.admission.acceptance.claim(accepted.receipt.id, prepared)).toThrow(
      'authority changed'
    );
    expect(receipts(f.db)[0]?.state).toBe('accepted');
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('accepted');
    expect(f.store.getGrant(f.grantId)?.revokedAt).not.toBeNull();
    writeFileSync(file, old);
    expect(() => f.admission.acceptance.claim(accepted.receipt.id, prepared)).toThrow(
      'GRANT_REVOKED'
    );
  });
  it('does not treat an unrelated settlement as document turn completion', () => {
    const f = fixture();
    const accepted = f.admission.admit(f.batchId());
    f.admission.acceptance.settle('unrelated-receipt', 'ok');
    f.admission.acceptance.settle(accepted.receipt.id, 'ok');
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('accepted');
    expect(receipts(f.db)[0]?.state).toBe('accepted');
  });
  it('quarantines a previous-boot claimed document without repeating it', async () => {
    const f = fixture();
    const accepted = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    f.admission.acceptance.claim(accepted.receipt.id, prepared);
    const reboot = batchFixture(
      ':memory:',
      null,
      { db: f.db, documentId: f.documentId, grantId: f.grantId },
      'boot-2'
    );
    expect(receipts(f.db)[0]?.state).toBe('outcome_unknown');
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('in_doubt');
    expect(reboot.admission.acceptance.listAccepted('session-1')).toEqual([]);
  });
  it.each(['onAccepted', 'revalidate'] as const)(
    'rejects an async %s and retires late transaction mutation',
    async (hook) => {
      const f = fixture();
      const original = f.admission.source[hook];
      let lateRejected = false;
      let nativeLateRejected = false;
      const late = async (tx: Parameters<typeof original>[0]) => {
        const lateRun = tx.update(canvasDocGrants).set({ revokedAt: NOW }).run;
        const nativeRun = (
          tx as unknown as {
            session: { client: { prepare(sql: string): { run(): unknown } } };
          }
        ).session.client.prepare("UPDATE canvas_doc_grants SET revoked_at = 'late'").run;
        await Promise.resolve();
        try {
          nativeRun();
        } catch {
          nativeLateRejected = true;
        }
        try {
          lateRun();
        } catch {
          lateRejected = true;
        }
        throw new Error('late source refusal');
      };
      const unsafe = f.admission.source as unknown as Record<string, unknown>;
      unsafe[hook] = late;
      if (hook === 'onAccepted') {
        expect(() => f.admission.admit(f.batchId())).toThrow('must be synchronous');
        expect(receipts(f.db)).toEqual([]);
        expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
      } else {
        unsafe[hook] = original;
        const accepted = f.admission.admit(f.batchId());
        const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
        unsafe[hook] = late;
        expect(() => f.admission.acceptance.claim(accepted.receipt.id, prepared)).toThrow(
          'must be synchronous'
        );
        expect(receipts(f.db)[0]?.state).toBe('accepted');
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(lateRejected).toBe(true);
      expect(nativeLateRejected).toBe(true);
      expect(f.store.getGrant(f.grantId)?.revokedAt).toBeNull();
    }
  );
  it('slices exact originals below the full rendered byte ceiling and keeps the overflow deadline', () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) f.input({ text: 'x'.repeat(15000) });
    const batch = f.batchId();
    const deadline = f.store.getBatch(batch)!.dueAt;
    const accepted = f.admission.admit(batch);
    const selected = f.store.getBatch(batch)!;
    expect(selected.inputEventIds.length).toBeLessThan(9);
    const overflow = f.store.getBatch(f.batchId())!;
    expect(overflow.dueAt).toBe(deadline);
    expect(selected.inputEventIds.length + overflow.inputEventIds.length).toBe(9);
    return f.admission.acceptance.prepare(accepted.receipt.id).then((p) => {
      expect(docEventsPromptBytes(p.docEvents!)).toBeLessThanOrEqual(80 * 1024 - 1200);
      expect(renderDocEvents(p.docEvents!)).not.toContain('Private body');
    });
  });
});
