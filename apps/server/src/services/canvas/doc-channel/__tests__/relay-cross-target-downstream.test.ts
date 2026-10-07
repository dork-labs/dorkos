/** Genuine approved responder service writes; native ledger seeding is not ACK evidence. */
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ackFixture, actor, folders, send } from './downstream-fixtures.js';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'doc-cross-target-responder-'));
  folders.push(dir);
  return ackFixture(undefined, join(dir, 'db.sqlite'));
}
it('the approved other-session target sends a real partial ACK and correlated reply while owning document access stays denied', async () => {
  const f = fixture();
  await expect(f.authorization.require(f.doc.id, f.responder, true)).rejects.toMatchObject({
    status: 404,
  });
  const ack = f.ack();
  const handled = await f.service.send(ack, f.responder);
  expect(f.store.getEvent(f.doc.id, handled.receipt.id)).toMatchObject({
    direction: 'downstream',
    type: 'app.ack',
  });
  expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]).toMatchObject({
    ackOutcome: 'handled',
    ackEvidence: { downstreamEventId: ack.eventId, grantId: f.grant.grantId },
  });
  expect(f.store.listDeliveries(f.doc.id, f.ids[1]!)[0]!.ackOutcome).toBeNull();
  const reply = {
    ...send(f.doc.id),
    type: 'agent.reply',
    payload: { inReplyTo: [f.ids[1]!], text: 'Approved target response' },
  };
  const sent = await f.service.send(reply, f.responder);
  expect(f.store.getEvent(f.doc.id, sent.receipt.id)).toMatchObject({
    type: 'agent.reply',
    payload: reply.payload,
  });
  expect(await f.service.send(reply, f.responder)).toEqual({
    receipt: { ...sent.receipt, status: 'duplicate' },
  });
  expect(f.store.listDeliveries(f.doc.id, f.ids[1]!)[0]!.ackOutcome).toBeNull();
  expect(f.store.getBatch('batch')!.status).toBe('turn_done');
  expect(f.queue.list('target-session')).toEqual([]);
  await expect(f.service.send(send(f.doc.id), f.responder)).rejects.toMatchObject({ status: 404 });
});
it('unknown or mixed reply IDs and foreign target identity cannot mutate original downstream state', async () => {
  const f = fixture(),
    before = f.store.getChannel(f.doc.id)!.nextDocSeq;
  const reply = (ids: string[]) => ({
    ...send(f.doc.id),
    type: 'agent.reply',
    payload: { inReplyTo: ids, text: 'Refused response' },
  });
  await expect(f.service.send(reply([randomUUID()]), f.responder)).rejects.toThrow();
  await expect(f.service.send(reply([f.ids[0]!, randomUUID()]), f.responder)).rejects.toThrow();
  await expect(
    f.service.send(reply([f.ids[0]!]), actor('foreign', 'target-session', '/agents/target'))
  ).rejects.toThrow();
  await expect(f.service.send(f.ack([f.ids[0]!, randomUUID()]), f.responder)).rejects.toThrow();
  expect(f.store.getChannel(f.doc.id)!.nextDocSeq).toBe(before);
  expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
});
it('revoked approved target correlation refuses both actual reply and ACK including a previously recorded duplicate', async () => {
  const f = fixture();
  const reply = {
    ...send(f.doc.id),
    type: 'agent.reply',
    payload: { inReplyTo: [f.ids[0]!], text: 'Original reply' },
  };
  await f.service.send(reply, f.responder);
  const before = f.store.getChannel(f.doc.id)!.nextDocSeq;
  f.grants.revoke(f.doc.id, f.grant.grantId, actor());
  await expect(f.service.send(reply, f.responder)).rejects.toThrow('GRANT_REVOKED');
  await expect(f.service.send(f.ack(), f.responder)).rejects.toThrow('GRANT_REVOKED');
  expect(f.store.getChannel(f.doc.id)!.nextDocSeq).toBe(before);
  expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
});
