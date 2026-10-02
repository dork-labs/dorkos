/** Pending admission follows the same source-owned refusal policy as accepted recovery. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  canvasDocuments,
  canvasDocIdentityIntents,
  eq,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  type Db,
} from '@dorkos/db';
import { batchFixture, NOW } from './batch-fixtures.js';
import { DocChannelAuthorization, DocChannelNotFoundError } from '../authorization.js';
import { DocChannelIdentityBlockedError } from '../lifecycle.js';
import { DocRouteGrantError } from '../grant-policy.js';
import { PrivateSessionMessageRefusalError } from '../../../session/private-messages/refusal.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';

const databases: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(manifest = false) {
  const directory = mkdtempSync(join(tmpdir(), 'doc-pending-authority-'));
  directories.push(directory);
  mkdirSync(join(directory, '.dork'));
  const manifestPath = join(directory, '.dork/app.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ v: 1, types: { 'task.changed': { type: 'object' } } })
  );
  let time = Date.parse(NOW);
  const now = () => new Date(time);
  const f = batchFixture(
    join(directory, 'state.db'),
    manifest ? directory : null,
    undefined,
    'boot-1',
    'claude-code',
    now
  );
  databases.push(f.db);
  f.input();
  time += 1001;
  const nudge = vi.fn(() => undefined);
  const pump = new DocBatchDeliveryPump({
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now,
    capacity: () => ({ available: true }),
    budget: () => ({ available: true }),
    markWaitingWarning: () => false,
    nudge,
  });
  return {
    f,
    pump,
    nudge,
    now,
    manifestPath,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

it.each(['pending', 'in_doubt', 'failed', '503', 'unavailable', 'unknown'] as const)(
  'retains pending identity on actual authorization %s refusal and retries only at its durable wake',
  (failure) => {
    const h = fixture();
    const { f } = h;
    const before = f.store.getBatch(f.batchId())!;
    const inputs = before.inputEventIds.map((id) => f.store.getEvent(f.documentId, id));
    expect(inputs.every((input) => input !== undefined)).toBe(true);
    let blocked = true;
    let refusal: unknown;
    const authorization = new DocChannelAuthorization(f.db, f.documents, {
      ownsInstallation: () => true,
      roomMembership: () => undefined,
      principalCurrent: () => {
        if (blocked && failure === '503')
          throw new DocRouteGrantError('TEMPORARILY_UNAVAILABLE', 503);
        if (blocked && failure === 'unavailable')
          throw new PrivateSessionMessageRefusalError('source_adapter_unavailable', 'Unavailable');
        if (blocked && failure === 'unknown') throw new Error('Unavailable');
        return true;
      },
    });
    f.authority.requireGrantedCurrent = (grant, tx) => {
      try {
        return authorization.requireCurrent(grant.documentId, f.actor, true, tx);
      } catch (error) {
        refusal = error;
        throw error;
      }
    };
    if (['pending', 'in_doubt', 'failed'].includes(failure)) {
      f.db
        .insert(canvasDocIdentityIntents)
        .values({
          intentId: 'hold',
          documentId: f.documentId,
          fromScope: before.scope,
          toScope: 'session:canonical',
          sourceId: before.batchId,
          sourceGeneration: before.generation,
          evidence: {},
          status: failure as 'pending' | 'in_doubt' | 'failed',
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }
    const revalidate = f.grants.revalidateBatchGrant.bind(f.grants);
    const validate = vi.spyOn(f.grants, 'revalidateBatchGrant').mockImplementation((...args) => {
      try {
        return revalidate(...args);
      } catch (error) {
        refusal = error;
        throw error;
      }
    });
    const result = h.pump.run();
    expect(f.admission.source.isPreclaimRefusal(refusal)).toBe(false);
    if (['pending', 'in_doubt', 'failed'].includes(failure)) {
      expect(refusal).toBeInstanceOf(DocChannelNotFoundError);
      expect(refusal).toMatchObject({ cause: expect.any(DocChannelIdentityBlockedError) });
    }
    const next = new Date(h.now().getTime() + 60000).toISOString();
    expect(result).toEqual({
      admitted: 0,
      waiting: 1,
      expired: 0,
      cancelled: 0,
      nextEligibleAt: next,
    });
    const waiting = f.store.getBatch(before.batchId)!;
    expect(waiting).toMatchObject({
      batchId: before.batchId,
      documentId: before.documentId,
      scope: before.scope,
      routeId: before.routeId,
      grantId: before.grantId,
      grantRevision: before.grantRevision,
      generation: before.generation,
      dueAt: before.dueAt,
      effectivePayload: before.effectivePayload,
      inputEventIds: before.inputEventIds,
      attempt: before.attempt + 1,
      status: 'waiting',
      leaseUntil: next,
      errorCode: 'pump_refused',
      admissionReceiptId: null,
    });
    expect(before.inputEventIds.map((id) => f.store.getEvent(f.documentId, id))).toEqual(inputs);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(h.nudge).not.toHaveBeenCalled();
    const calls = validate.mock.calls.length;
    h.advance(59999);
    expect(h.pump.run().admitted).toBe(0);
    expect(validate).toHaveBeenCalledTimes(calls);
    expect(f.store.getBatch(before.batchId)).toEqual(waiting);
    blocked = false;
    f.db
      .delete(canvasDocIdentityIntents)
      .where(eq(canvasDocIdentityIntents.intentId, 'hold'))
      .run();
    h.advance(1);
    expect(h.pump.run().admitted).toBe(1);
    expect(h.nudge).toHaveBeenCalledExactlyOnceWith('session-1', [
      f.db.select().from(sessionMessageAcceptanceReceipts).get()!.id,
    ]);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      sourceId: before.batchId,
      sourceGeneration: before.generation,
      state: 'accepted',
      dispatchAttemptId: null,
    });
    expect(f.store.getBatch(before.batchId)?.inputEventIds).toEqual(before.inputEventIds);
    expect(f.db.select().from(sessionMessageQueue).all()).toHaveLength(1);
    expect(h.pump.run().admitted).toBe(0);
    expect(h.nudge).toHaveBeenCalledTimes(1);
  }
);

it.each(['delete', 'close', 'revoke', 'invalid-manifest', 'owner-lost'] as const)(
  'cancels pending input on genuine %s authority loss',
  (loss) => {
    const h = fixture(loss === 'invalid-manifest');
    const { f } = h;
    const before = f.store.getBatch(f.batchId())!;
    const inputs = before.inputEventIds.map((id) => f.store.getEvent(f.documentId, id));
    const authorization = new DocChannelAuthorization(f.db, f.documents, {
      ownsInstallation: () => loss !== 'owner-lost',
      principalCurrent: () => true,
      roomMembership: () => undefined,
    });
    f.authority.requireGrantedCurrent = (grant, tx) =>
      authorization.requireCurrent(grant.documentId, f.actor, true, tx);
    if (loss === 'delete')
      f.db.delete(canvasDocuments).where(eq(canvasDocuments.id, f.documentId)).run();
    else if (loss === 'close') f.canvas.close(before.scope, f.documentId);
    else if (loss === 'revoke') f.grants.revoke(f.documentId, f.grantId, f.actor);
    else if (loss === 'invalid-manifest') writeFileSync(h.manifestPath, '{invalid');
    const result = h.pump.run();
    expect(result.admitted).toBe(0);
    expect(result.waiting).toBe(0);
    expect(result.nextEligibleAt).toBeNull();
    expect(f.store.getBatch(before.batchId)).toMatchObject({
      status: 'cancelled',
      generation: before.generation,
      inputEventIds: before.inputEventIds,
      admissionReceiptId: null,
    });
    expect(before.inputEventIds.map((id) => f.store.getEvent(f.documentId, id))).toEqual(inputs);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(h.nudge).not.toHaveBeenCalled();
    if (loss === 'invalid-manifest') expect(f.store.getGrant(f.grantId)?.revokedAt).not.toBeNull();
  }
);
