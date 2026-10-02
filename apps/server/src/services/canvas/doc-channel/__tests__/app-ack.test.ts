/** Correlated acknowledgments require actual exact route approval and current responder identity. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { agents, sessionMetadata, eq, sql } from '@dorkos/db';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { replayDocChannel } from '../replay.js';
import { actor, send, ackFixture } from './downstream-fixtures.js';
import { NOW, FROM } from './lifecycle-fixtures.js';
describe('exact approved target application acknowledgments', () => {
  it('refuses an authenticated target-shaped principal belonging to another installation', async () => {
    const f = ackFixture();
    const claims = f.responder.principal.claims;
    const outsider = {
      ...f.responder,
      principal: createServerPrincipal({
        ...claims,
        owner: { kind: 'local_install', installationId: 'another-installation' },
      }),
    };
    await expect(f.service.send(f.ack(), outsider)).rejects.toMatchObject({ status: 404 });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
  });
  it('allows a granted responder without owning-session access, keeps turn_done unfulfilled, and settles only named inputs', async () => {
    const f = ackFixture();
    await expect(f.authorization.require(f.doc.id, f.responder, true)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
    const input = f.ack();
    const first = await f.service.send(input, f.responder);
    expect(await f.service.send(input, f.responder)).toEqual({
      receipt: { ...first.receipt, status: 'duplicate' },
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]).toMatchObject({
      status: 'turn_done',
      ackOutcome: 'handled',
      ackEvidence: { generation: 'generation', grantId: f.grant.grantId },
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[1]!)[0]!.ackOutcome).toBeNull();
    await f.service.send(f.ack([f.ids[1]!], 'rejected'), f.responder);
    const snapshot = replayDocChannel(f.store, () => ({
      documentId: f.doc.id,
      scope: FROM,
      documentLabel: 'doc',
      provenance: {},
      routes: [],
    }));
    expect(snapshot.receipts.find((row) => row.id === f.ids[1])!.deliveries[0]!.ackOutcome).toBe(
      'rejected'
    );
    expect(f.store.getBatch('batch')!.status).toBe('turn_done');
    expect(f.queue.list('target-session')).toHaveLength(0);
  });
  it('rejects mixed invalid IDs, duplicate IDs, wrong routes and unrelated writers without a partial ack', async () => {
    const f = ackFixture();
    for (const input of [
      f.ack([f.ids[0]!, randomUUID()]),
      f.ack([f.ids[0]!, f.ids[0]!]),
      {
        ...f.ack(),
        payload: { batchId: 'batch', routeId: 'wrong', eventIds: [f.ids[0]], outcome: 'handled' },
      },
    ])
      await expect(f.service.send(input, f.responder)).rejects.toThrow();
    await expect(f.service.send(f.ack(), actor())).rejects.toMatchObject({ status: 404 });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
    expect(f.store.getChannel(f.doc.id)!.nextDocSeq).toBe(3);
  });
  it('rejects frozen-path relocation, revoked grants, and closure even for an already recorded duplicate', async () => {
    const f = ackFixture();
    const input = f.ack();
    await f.service.send(input, f.responder);
    f.db.update(agents).set({ projectPath: '/agents/moved' }).where(eq(agents.id, 'target')).run();
    f.db
      .update(sessionMetadata)
      .set({ agentPath: '/agents/moved' })
      .where(eq(sessionMetadata.sessionId, 'target-session'))
      .run();
    await expect(
      f.service.send(input, actor('target', 'target-session', '/agents/moved'))
    ).rejects.toThrow('TARGET_IDENTITY_CHANGED');
    f.db.update(agents).set({ projectPath: '/agents/target' }).where(eq(agents.id, 'target')).run();
    f.db
      .update(sessionMetadata)
      .set({ agentPath: '/agents/target' })
      .where(eq(sessionMetadata.sessionId, 'target-session'))
      .run();
    f.grants.revoke(f.doc.id, f.grant.grantId, actor());
    await expect(f.service.send(input, f.responder)).rejects.toThrow('GRANT_REVOKED');
    f.store.markClosed(f.doc.id, NOW, { reason: 'test closure' });
    await expect(f.service.send(input, f.responder)).rejects.toThrow();
  });
  it('rechecks revocation after asynchronous preparation and refuses generic writes from the narrow responder', async () => {
    const f = ackFixture();
    await expect(f.service.send(send(f.doc.id), f.responder)).rejects.toMatchObject({
      status: 404,
    });
    const prepare = f.authority.prepare.bind(f.authority);
    vi.spyOn(f.authority, 'prepare').mockImplementation(async (...args) => {
      await prepare(...args);
      f.grants.revoke(f.doc.id, f.grant.grantId, actor());
    });
    await expect(f.service.send(f.ack(), f.responder)).rejects.toThrow('GRANT_REVOKED');
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
  });
  it('refuses changed downstream IDs and conflicting later acknowledgments without erasing original evidence', async () => {
    const f = ackFixture();
    const input = f.ack();
    await f.service.send(input, f.responder);
    await expect(
      f.service.send({ ...input, payload: { ...input.payload, outcome: 'rejected' } }, f.responder)
    ).rejects.toMatchObject({ status: 409 });
    await expect(f.service.send(f.ack([f.ids[0]!], 'rejected'), f.responder)).rejects.toMatchObject(
      { status: 409 }
    );
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]).toMatchObject({
      ackOutcome: 'handled',
      ackEvidence: { downstreamEventId: input.eventId },
    });
  });
  it('rolls back per-input evidence when the downstream event cannot be persisted', async () => {
    const f = ackFixture();
    f.db.$client.exec(
      "CREATE TRIGGER fail_ack BEFORE INSERT ON canvas_doc_events WHEN NEW.direction='downstream' BEGIN SELECT RAISE(ABORT,'injected ack failure'); END"
    );
    await expect(f.service.send(f.ack(), f.responder)).rejects.toMatchObject({ status: 507 });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]).toMatchObject({
      ackOutcome: null,
      acknowledgedAt: null,
      ackEvidence: null,
    });
    expect(f.store.getChannel(f.doc.id)!.nextDocSeq).toBe(3);
  });
  it('explicitly refuses room responses without an admitted responder proof and pending batches', async () => {
    const f = ackFixture();
    f.db.run(sql`UPDATE canvas_doc_batches SET status='pending' WHERE batch_id='batch'`);
    await expect(f.service.send(f.ack(), f.responder)).rejects.toMatchObject({ status: 404 });
    f.db.run(sql`UPDATE canvas_doc_batches SET status='turn_done' WHERE batch_id='batch'`);
    const original = f.grants.revalidateBatchGrant.bind(f.grants);
    vi.spyOn(f.grants, 'revalidateBatchGrant').mockImplementation((...args) => {
      const checked = original(...args);
      return { ...checked, target: { ...checked.target, scope: 'room:local-room' } };
    });
    await expect(f.service.send(f.ack(), f.responder)).rejects.toMatchObject({
      code: 'ROOM_APP_ACK_RESPONDER_UNAVAILABLE',
      status: 409,
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
  });
});
