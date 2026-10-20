/** Original-effect recovery across real settings-first canonical identity moves. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  eq,
  sql,
  sessionMetadata,
  canvasDocIdentityIntents,
  canvasDocFileSaveIntents,
} from '@dorkos/db';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { FileDocumentSaveReceiptSchema } from '@dorkos/shared/schemas';
import { initBoundary } from '../../../../../lib/boundary.js';
import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
import { controlUi } from '../../../../session/browser-seat/ui-control.js';
import { authorityFixture } from './authority-fixtures.js';
import { saveOriginalDocumentFile } from '../installation-file-writes.js';
import { readSessionDocSourceDescriptor } from '../../doc-source-policy.js';
import { sameOriginalFileSaveSource } from '../file-save-recovery/applied-source.js';
import { createDocChannelHttpComposition } from '../../http-composition.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const h = await authorityFixture(false, false, true);
  cleanup.push(h.cleanup);
  cleanup.push(() => h.http.fileWrites.stop());
  await initBoundary(h.dir);
  // The ordinary operator FILE has no app route/grant. Retire the fixture's separate checkbox.
  h.rooms.canvas.close(h.scope, h.input.documentId);
  const opened = await controlUi(
    {
      action: 'open_canvas',
      content: { type: 'file', title: 'Original operator file', sourcePath: h.path },
    },
    { sessionId: 'session-a', cwd: h.dir, principal: h.runtime.principal }
  );
  if (typeof opened.documentId !== 'string') throw new Error('Production FILE missing');
  const documentId = opened.documentId;
  const source = readSessionDocSourceDescriptor(
    { db: h.db, documents: h.rooms.canvasDocuments },
    documentId
  );
  expect(source.treeKind).toBeNull();
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await h.http.service.replay(documentId, h.actor)).incarnation
  );
  const input = {
    cwd: h.dir,
    path: h.path,
    expectedContent: await fs.readFile(h.path, 'utf8'),
    content: 'Original saved replacement',
    documentSave: { documentId, eventId: randomUUID(), incarnation },
  };
  const save = () => saveOriginalDocumentFile(h.http.fileWrites, input, { headers: {} });
  const row = () =>
    h.db
      .select()
      .from(canvasDocFileSaveIntents)
      .where(eq(canvasDocFileSaveIntents.eventId, input.documentSave.eventId))
      .get()!;
  const registry = new RuntimeRegistry();
  registry.setDb(h.db);
  const metadataMove = (from: string, to: string) => registry.rekeySessionSettings(from, to);
  const canvasMove = (from: string, to: string) =>
    h.rooms.canvasDocuments.rekeyScope(`session:${from}`, `session:${to}`);
  const move = async (from: string, to: string) => {
    await metadataMove(from, to);
    canvasMove(from, to);
  };
  const fail = () =>
    h.db.run(
      sql`CREATE TRIGGER refuse_rekey_saved_receipt BEFORE INSERT ON canvas_doc_events WHEN NEW.type='doc.saved' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`
    );
  const allow = () => h.db.run(sql`DROP TRIGGER refuse_rekey_saved_receipt`);
  const receipt = (body: unknown) =>
    FileDocumentSaveReceiptSchema.parse((body as { documentReceipt?: unknown }).documentReceipt);
  const observed = () =>
    readSessionDocSourceDescriptor({ db: h.db, documents: h.rooms.canvasDocuments }, documentId);
  return {
    h,
    documentId,
    source,
    input,
    save,
    row,
    metadataMove,
    canvasMove,
    move,
    fail,
    allow,
    receipt,
    observed,
  };
}
it('settings-first postreplacement rekey settles the original UUID once and preserves immutable evidence', async () => {
  const f = await setup(),
    renames = vi.spyOn(fs, 'rename');
  f.fail();
  await expect(f.save()).rejects.toThrow('receipt unavailable');
  const original = f.row();
  expect(original.status).toBe('in_doubt');
  await f.metadataMove('session-a', 'canonical-a');
  // The real metadata-before-Canvas gap does not borrow the destination root as an alias.
  await expect(f.save()).rejects.toThrow();
  expect(f.row().status).toBe('in_doubt');
  f.canvasMove('session-a', 'canonical-a');
  f.allow();
  const saved = f.receipt((await f.save()).body);
  expect(saved.status).toBe('duplicate');
  expect(f.row()).toMatchObject({
    status: 'committed',
    source: original.source,
    requestHash: original.requestHash,
    incarnation: original.incarnation,
    eventId: original.eventId,
  });
  expect(f.observed().scope).toBe('session:canonical-a');
  expect(renames.mock.calls.filter(([, target]) => target === f.h.path)).toHaveLength(1);
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(f.input.content);
  expect(f.h.http.channels.getEvent(f.documentId, saved.eventId)).toMatchObject({
    type: 'doc.saved',
    docSeq: saved.docSeq,
  });
});
it('two successful canonical moves retain the original physical birth and never replay its write', async () => {
  const f = await setup(),
    renames = vi.spyOn(fs, 'rename');
  f.fail();
  await expect(f.save()).rejects.toThrow();
  f.allow();
  await f.move('session-a', 'canonical-a');
  await f.move('canonical-a', 'canonical-b');
  await f.h.http.fileWrites.stop();
  const restarted = createDocChannelHttpComposition({
    db: f.h.db,
    documents: f.h.rooms.canvasDocuments,
    rooms: f.h.rooms.service,
    roomStore: f.h.rooms.store,
    roomRepos: f.h.roomRepos,
    approvals: f.h.approvals,
    installationId: 'authority-install',
  });
  cleanup.push(() => restarted.fileWrites.stop());
  const recovered = await saveOriginalDocumentFile(restarted.fileWrites, f.input, { headers: {} });
  expect(f.receipt(recovered.body)).toMatchObject({
    status: 'duplicate',
    incarnation: f.input.documentSave.incarnation,
  });
  expect(renames.mock.calls.filter(([, target]) => target === f.h.path)).toHaveLength(1);
});
it('a committed duplicate after canonical move stays historical after a later generic write', async () => {
  const f = await setup();
  const saved = f.receipt((await f.save()).body);
  await f.move('session-a', 'canonical-a');
  await f.h.http.fileWrites.save({ cwd: f.h.dir, path: f.h.path, content: 'Later current bytes' });
  const renames = vi.spyOn(fs, 'rename');
  expect(f.receipt((await f.save()).body)).toEqual({ ...saved, status: 'duplicate' });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe('Later current bytes');
  expect(renames).not.toHaveBeenCalled();
});
it('a changed current registered root cannot settle old authority even with applied move evidence', async () => {
  const f = await setup();
  f.fail();
  await expect(f.save()).rejects.toThrow();
  f.allow();
  await f.move('session-a', 'canonical-a');
  f.h.db
    .update(sessionMetadata)
    .set({ agentPath: `${f.h.dir}/different-root` })
    .where(eq(sessionMetadata.sessionId, 'canonical-a'))
    .run();
  await expect(f.save()).rejects.toThrow();
  expect(f.row().status).toBe('in_doubt');
  expect(f.h.http.channels.getEvent(f.documentId, f.input.documentSave.eventId)).toBeUndefined();
});
it.each([
  'missing',
  'failed',
  'pending',
  'wrong-document',
  'wrong-source',
  'malformed-evidence',
  'unknown-status',
  'cycle',
  'ambiguous',
] as const)(
  'retained %s identity evidence never clears the original physical path fence',
  async (kind) => {
    const f = await setup();
    f.fail();
    await expect(f.save()).rejects.toThrow();
    f.allow();
    await f.move('session-a', 'canonical-a');
    const edge = f.h.db
      .select()
      .from(canvasDocIdentityIntents)
      .where(eq(canvasDocIdentityIntents.documentId, f.documentId))
      .get()!;
    if (kind === 'missing')
      f.h.db
        .delete(canvasDocIdentityIntents)
        .where(eq(canvasDocIdentityIntents.intentId, edge.intentId))
        .run();
    if (kind === 'failed' || kind === 'pending')
      f.h.db
        .update(canvasDocIdentityIntents)
        .set({ status: kind })
        .where(eq(canvasDocIdentityIntents.intentId, edge.intentId))
        .run();
    if (kind === 'wrong-document')
      f.h.db
        .update(canvasDocIdentityIntents)
        .set({ sourceId: 'another-document' })
        .where(eq(canvasDocIdentityIntents.intentId, edge.intentId))
        .run();
    if (kind === 'wrong-source')
      f.h.db
        .update(canvasDocIdentityIntents)
        .set({ evidence: { sourceKey: 'unrelated-source' } })
        .where(eq(canvasDocIdentityIntents.intentId, edge.intentId))
        .run();
    if (kind === 'malformed-evidence')
      f.h.db
        .update(canvasDocIdentityIntents)
        .set({ evidence: { sourceKey: edge.sourceId, borrowed: true } })
        .where(eq(canvasDocIdentityIntents.intentId, edge.intentId))
        .run();
    if (kind === 'unknown-status')
      f.h.db.run(
        sql`UPDATE canvas_doc_identity_intents SET status='unknown' WHERE intent_id=${edge.intentId}`
      );
    if (kind === 'cycle' || kind === 'ambiguous')
      f.h.db
        .insert(canvasDocIdentityIntents)
        .values({
          ...edge,
          intentId: randomUUID(),
          fromScope: kind === 'cycle' ? edge.toScope : edge.fromScope,
          toScope: kind === 'cycle' ? edge.fromScope : 'session:another-destination',
        })
        .run();
    await expect(f.save()).rejects.toThrow();
    expect(f.row().status).toBe('in_doubt');
    expect(f.h.http.channels.getEvent(f.documentId, f.input.documentSave.eventId)).toBeUndefined();
    await expect(
      f.h.http.fileWrites.save({ cwd: f.h.dir, path: f.h.path, content: 'Fence bypass' })
    ).rejects.toThrow();
  }
);
it('proof disappears after disk verification: the owning completion transaction refuses conversion', async () => {
  const f = await setup();
  f.fail();
  await expect(f.save()).rejects.toThrow();
  f.allow();
  await f.move('session-a', 'canonical-a');
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (args[0] === f.h.path && args[1] === 'r') {
      f.h.db
        .delete(canvasDocIdentityIntents)
        .where(eq(canvasDocIdentityIntents.documentId, f.documentId))
        .run();
    }
    return handle;
  });
  await expect(f.save()).rejects.toMatchObject({ code: 'DOC_SAVE_IN_DOUBT' });
  expect(f.row().status).toBe('in_doubt');
  expect(f.h.http.channels.getEvent(f.documentId, f.input.documentSave.eventId)).toBeUndefined();
});
it('source equivalence does not accept changed non-scope source fields', async () => {
  const f = await setup();
  await f.move('session-a', 'canonical-a');
  const current = f.observed();
  expect(sameOriginalFileSaveSource(f.h.db, f.source, current)).toBe(true);
  for (const patch of [
    { authorId: 'another-author' },
    { sourceIdentity: 'another-key' },
    { sourcePath: 'another-path' },
    { resolvedCwd: '/another-root' },
    { treeKind: 'agent-cwd' },
    { openedAt: new Date(Date.parse(current.openedAt) + 1000).toISOString() },
  ]) {
    expect(sameOriginalFileSaveSource(f.h.db, f.source, { ...current, ...patch })).toBe(false);
  }
});
