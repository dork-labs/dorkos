/** Real migrated SQLite and capability failure proofs for quiet downstream persistence. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canvasDocChannels, canvasDocuments, createDb, runMigrations, eq, sql } from '@dorkos/db';
import { CANVAS_CHANNEL_STATE_BYTES } from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelAuthorization, type DocChannelActor } from '../authorization.js';
import { CanvasDocumentStore } from '../../canvas-document-store.js';
import { DocChannelStore } from '../store.js';
import { DocChannelDownstream, type DocDownstreamAuthority } from '../downstream/service.js';
import { createDocChannelDownstreamCapabilities } from '../downstream/capabilities.js';
import { databases, folders, actor, fixture, send, patch } from './downstream-fixtures.js';
import { NOW, FROM } from './lifecycle-fixtures.js';
describe('durable downstream capabilities', () => {
  it('returns durable original receipts and revisions after closing and reopening the production SQLite database', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'doc-downstream-'));
    folders.push(folder);
    const filename = join(folder, 'db.sqlite');
    const f = fixture(60, filename);
    const input = patch(f.doc.id);
    const original = await f.service.patchState(input, actor());
    await f.service.patchState(patch(f.doc.id, 1), actor());
    f.db.$client.close();
    databases.splice(databases.indexOf(f.db), 1);
    const db = createDb(filename);
    databases.push(db);
    runMigrations(db);
    const store = new DocChannelStore(db);
    const documents = new CanvasDocumentStore(db);
    const authorization = new DocChannelAuthorization(db, documents, {
      ownsInstallation: () => true,
      principalCurrent: () => true,
      roomMembership: () => undefined,
    });
    const authority: DocDownstreamAuthority = {
      async prepare(documentId, caller) {
        await authorization.require(documentId, caller, true);
      },
      requireWriteCurrent(documentId, caller, tx) {
        return {
          ...authorization.requireCurrent(documentId, caller, true, tx),
          senderKey: 'runtime:claude-code:agent-1:session:session-1',
          evidence: {},
        };
      },
      requireResponderCurrent() {
        throw new Error('Not used by state patch');
      },
    };
    expect(await new DocChannelDownstream(store, authority).patchState(input, actor())).toEqual({
      ...original,
      receipt: { ...original.receipt, status: 'duplicate' },
    });
    expect(store.getChannel(f.doc.id)).toMatchObject({ stateRev: 2, nextDocSeq: 3 });
  });
  it('enforces full UTF-8 envelopes at the exact wire limit and bounds operations before any state mutation', async () => {
    const f = fixture();
    const input = send(f.doc.id, '');
    input.payload = 'x'.repeat(16384 - Buffer.byteLength(JSON.stringify(input)));
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(16384);
    await f.service.send(input, actor());
    await expect(
      f.service.send({ ...input, eventId: randomUUID(), payload: input.payload + 'x' }, actor())
    ).rejects.toThrow();
    await expect(f.service.send(send(f.doc.id, '😀'.repeat(5000)), actor())).rejects.toThrow();
    await f.service.patchState(
      patch(
        f.doc.id,
        0,
        Array.from({ length: 100 }, (_, i) => ({ op: 'set', path: `/n${i}`, value: i }))
      ),
      actor()
    );
    await expect(
      f.service.patchState(
        patch(
          f.doc.id,
          1,
          Array.from({ length: 101 }, (_, i) => ({ op: 'set', path: `/n${i}`, value: i }))
        ),
        actor()
      )
    ).rejects.toThrow();
    expect(f.store.getChannel(f.doc.id)!.stateRev).toBe(1);
  });
  it('serializes competing state CAS and identical concurrent IDs without duplicate events or revision increments', async () => {
    const f = fixture();
    const input = patch(f.doc.id);
    const same = await Promise.all([
      f.service.patchState(input, actor()),
      f.service.patchState(input, actor()),
    ]);
    expect(same.map((result) => result.receipt.status).sort()).toEqual(['duplicate', 'recorded']);
    const competing = await Promise.allSettled([
      f.service.patchState(patch(f.doc.id, 1), actor()),
      f.service.patchState(patch(f.doc.id, 1), actor()),
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 2, nextDocSeq: 3 });
  });
  it('persists quietly through shared capability bodies and returns original duplicates before sender rate', async () => {
    const f = fixture(1);
    const input = send(f.doc.id);
    const capability = createDocChannelDownstreamCapabilities(f.service).find(
      (item) => item.id === 'ui.send_canvas_event'
    )!;
    const first = await capability.invoke({} as never, input, {
      serverPrincipal: actor().principal,
    } as never);
    expect(first).toMatchObject({ receipt: { status: 'recorded', docSeq: 1 } });
    expect(await f.service.send(input, actor())).toMatchObject({
      receipt: { status: 'duplicate', docSeq: 1 },
    });
    await expect(f.service.send(send(f.doc.id), actor())).rejects.toMatchObject({ status: 429 });
    await expect(f.service.send({ ...input, payload: 'changed' }, actor())).rejects.toMatchObject({
      status: 409,
    });
    expect(f.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_batches`)!.n).toBe(0);
    expect(f.queue.list('session-1')).toHaveLength(0);
  });
  it('refuses wrong scope, target room, forged principal and revoked principal even for duplicates', async () => {
    const f = fixture();
    const input = send(f.doc.id);
    await expect(f.service.send(input, actor('agent-1', 'canonical'))).rejects.toMatchObject({
      status: 404,
    });
    await expect(f.service.send({ ...input, roomId: 'unrelated' }, actor())).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      f.service.send(input, { ...actor(), principal: { claims: actor().principal.claims } })
    ).rejects.toMatchObject({ status: 404 });
    await f.service.send(input, actor());
    f.revokePrincipal();
    await expect(f.service.send(input, actor())).rejects.toMatchObject({ status: 404 });
    expect(f.store.getChannel(f.doc.id)!.nextDocSeq).toBe(2);
  });
  it('returns the original patch revision after later updates and preserves actual content/edit lock', async () => {
    const f = fixture();
    f.db
      .update(canvasDocuments)
      .set({ editingBy: 'viewer', editingHeartbeatAt: NOW })
      .where(eq(canvasDocuments.id, f.doc.id))
      .run();
    const before = f.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, f.doc.id))
      .get();
    const first = patch(f.doc.id);
    const capability = createDocChannelDownstreamCapabilities(f.service).find(
      (item) => item.id === 'ui.patch_canvas_state'
    )!;
    expect(
      await capability.invoke({} as never, first, { serverPrincipal: actor().principal } as never)
    ).toMatchObject({ stateRev: 1 });
    await f.service.patchState(
      patch(f.doc.id, 1, [{ op: 'set', path: '/count', value: 2 }]),
      actor()
    );
    expect(await f.service.patchState(first, actor())).toMatchObject({
      stateRev: 1,
      receipt: { status: 'duplicate', docSeq: 1 },
    });
    await expect(f.service.patchState(patch(f.doc.id), actor())).rejects.toMatchObject({
      status: 409,
    });
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ state: { count: 2 }, stateRev: 2 });
    expect(
      f.db.select().from(canvasDocuments).where(eq(canvasDocuments.id, f.doc.id)).get()
    ).toEqual(before);
    expect(f.queue.list('session-1')).toHaveLength(0);
  });
  it('decodes literal pointers, handles arrays, and rejects prototype/escape/expression attacks atomically', async () => {
    const f = fixture();
    await f.service.patchState(
      patch(f.doc.id, 0, [{ op: 'set', path: '', value: { 'a/b': { '~name': [1, 2] } } }]),
      actor()
    );
    await f.service.patchState(
      patch(f.doc.id, 1, [
        { op: 'remove', path: '/a~1b/~0name/0' },
        { op: 'set', path: '/a~1b/~0name/-', value: 3 },
      ]),
      actor()
    );
    expect(f.store.getChannel(f.doc.id)!.state).toEqual({ 'a/b': { '~name': [2, 3] } });
    for (const path of [
      '/__proto__/polluted',
      '/constructor/x',
      '/prototype',
      '/bad~2',
      'state.count++',
      '/a~1b/~0name/01',
      '/missing/x',
    ]) {
      await expect(
        f.service.patchState(
          patch(f.doc.id, 2, [
            { op: 'set', path: '/transient', value: true },
            { op: 'set', path, value: 1 },
          ]),
          actor()
        )
      ).rejects.toThrow();
      expect(f.store.getChannel(f.doc.id)).toMatchObject({
        stateRev: 2,
        state: { 'a/b': { '~name': [2, 3] } },
      });
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('accepts the exact final-state byte boundary and rolls back a one-byte oversize result', async () => {
    const f = fixture();
    // Grow a persisted near-limit state with a small patch, independently of the patch wire ceiling.
    const state = { data: 'x'.repeat(CANVAS_CHANNEL_STATE_BYTES - 19) };
    f.db
      .update(canvasDocChannels)
      .set({ state, stateRev: 0 })
      .where(eq(canvasDocChannels.documentId, f.doc.id))
      .run();
    const request = patch(f.doc.id, 0, [{ op: 'set', path: '/n', value: 0 }]);
    await f.service.patchState(request, actor());
    expect(Buffer.byteLength(JSON.stringify(f.store.getChannel(f.doc.id)!.state))).toBe(
      CANVAS_CHANNEL_STATE_BYTES - 2
    );
    await f.service.patchState(
      patch(f.doc.id, 1, [{ op: 'set', path: '/n', value: 100 }]),
      actor()
    );
    expect(Buffer.byteLength(JSON.stringify(f.store.getChannel(f.doc.id)!.state))).toBe(
      CANVAS_CHANNEL_STATE_BYTES
    );
    await expect(
      f.service.patchState(patch(f.doc.id, 2, [{ op: 'set', path: '/n', value: 1000 }]), actor())
    ).rejects.toMatchObject({ status: 422 });
    expect(f.store.getChannel(f.doc.id)!.stateRev).toBe(2);
  });
  it('rolls state and sequence back when appending fails, and refuses delayed transaction authority writes', async () => {
    const f = fixture();
    const input = patch(f.doc.id);
    f.db.$client.exec(
      "CREATE TRIGGER fail_downstream BEFORE INSERT ON canvas_doc_events WHEN NEW.direction='downstream' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END"
    );
    await expect(f.service.patchState(input, actor())).rejects.toMatchObject({ status: 507 });
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ state: {}, stateRev: 0, nextDocSeq: 1 });
    f.db.$client.exec('DROP TRIGGER fail_downstream');
    const malicious = {
      ...f.authority,
      requireWriteCurrent: async (
        _id: string,
        _actor: DocChannelActor,
        tx: Parameters<DocDownstreamAuthority['requireWriteCurrent']>[2]
      ) => {
        await Promise.resolve();
        tx.run(sql`UPDATE canvas_doc_channels SET state_rev=9`);
        return { id: f.doc.id, scope: FROM, senderKey: 'x', evidence: {} };
      },
    } as unknown as DocDownstreamAuthority;
    await expect(
      new DocChannelDownstream(f.store, malicious).patchState(input, actor())
    ).rejects.toMatchObject({ code: 'INVALID_DOWNSTREAM_AUTHORITY' });
    await Promise.resolve();
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });
});
