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
import {
  FileSaveDiscoverySchema,
  FileSaveRecoverResultSchema,
} from '@dorkos/shared/file-save/recovery';
import { initBoundary } from '../../../../../lib/boundary.js';
import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
import { controlUi } from '../../../../session/browser-seat/ui-control.js';
import { authorityFixture } from './authority-fixtures.js';
import {
  saveOriginalDocumentFile,
  discoverOriginalDocumentFileSaves,
  recoverOriginalDocumentFileSave,
} from '../installation-file-writes.js';
import { readSessionDocSourceDescriptor } from '../../doc-source-policy.js';
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
  const discover = () =>
    discoverOriginalDocumentFileSaves(h.http.fileWrites, documentId, { headers: {} });
  const recover = () =>
    recoverOriginalDocumentFileSave(
      h.http.fileWrites,
      { documentId, eventId: input.documentSave.eventId, expectedIncarnation: incarnation },
      { headers: {} }
    );
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
    discover,
    recover,
    observed,
  };
}
it('metadata-first APPLIED move discovers and proof-recovers the original UUID with one total rename', async () => {
  const f = await setup(),
    rename = vi.spyOn(fs, 'rename');
  f.fail();
  await expect(f.save()).rejects.toThrow('receipt unavailable');
  const original = f.row();
  expect(original.status).toBe('in_doubt');
  await f.metadataMove('session-a', 'canonical-a');
  await expect(f.discover()).rejects.toThrow();
  await expect(f.recover()).rejects.toThrow();
  expect(f.row().status).toBe('in_doubt');
  f.canvasMove('session-a', 'canonical-a');
  f.allow();
  const window = FileSaveDiscoverySchema.parse(await f.discover());
  expect(window).toMatchObject({
    incarnation: original.incarnation,
    admission: 'blocked',
    entries: [{ eventId: original.eventId, state: 'review' }],
  });
  const recovered = FileSaveRecoverResultSchema.parse(await f.recover());
  expect(recovered.entry).toMatchObject({
    state: 'receipt',
    receipt: {
      eventId: original.eventId,
      incarnation: original.incarnation,
      fileHash: original.afterHash,
    },
    currentFileMatch: 'same_saved_replacement',
  });
  expect(f.row()).toMatchObject({
    source: original.source,
    eventId: original.eventId,
    incarnation: original.incarnation,
    requestHash: original.requestHash,
    status: 'committed',
  });
  expect(f.observed().scope).toBe('session:canonical-a');
  expect(rename.mock.calls.filter(([, target]) => target === f.h.path)).toHaveLength(1);
  const event = f.h.http.channels.getEvent(f.documentId, original.eventId);
  expect(event).toMatchObject({ type: 'doc.saved' });
  const duplicate = await f.recover();
  expect(duplicate.entry).toEqual(recovered.entry);
  expect((await f.discover()).admission).toBe('not_observed_blocked');
  expect(rename.mock.calls.filter(([, target]) => target === f.h.path)).toHaveLength(1);
});
it('committed history after an APPLIED move retains the original receipt without overwriting newer bytes', async () => {
  const f = await setup();
  await f.save();
  const original = f.row();
  await f.move('session-a', 'canonical-a');
  await fs.writeFile(f.h.path, 'newer independent bytes');
  const rename = vi.spyOn(fs, 'rename');
  const window = FileSaveDiscoverySchema.parse(await f.discover());
  expect(window.entries).toMatchObject([
    {
      state: 'receipt',
      eventId: original.eventId,
      receipt: { incarnation: original.incarnation, fileHash: original.afterHash },
    },
  ]);
  expect((await f.recover()).entry).toMatchObject({
    state: 'receipt',
    currentFileMatch: 'different',
    receipt: { eventId: original.eventId, fileHash: original.afterHash },
  });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe('newer independent bytes');
  expect(rename).not.toHaveBeenCalled();
  expect(f.row().source).toEqual(original.source);
});
it.each(['pending', 'failed'] as const)(
  'a retained %s move fails the selected bounded window and explicit recovery rather than skipping original evidence',
  async (status) => {
    const f = await setup();
    f.fail();
    await expect(f.save()).rejects.toThrow();
    f.allow();
    const original = f.row();
    await f.move('session-a', 'canonical-a');
    f.h.db
      .update(canvasDocIdentityIntents)
      .set({ status })
      .where(eq(canvasDocIdentityIntents.documentId, f.documentId))
      .run();
    const rename = vi.spyOn(fs, 'rename');
    await expect(f.discover()).rejects.toThrow();
    await expect(f.recover()).rejects.toThrow();
    expect(f.row()).toMatchObject({
      eventId: original.eventId,
      source: original.source,
      status: 'in_doubt',
    });
    expect(f.h.http.channels.getEvent(f.documentId, original.eventId)).toBeUndefined();
    expect(rename).not.toHaveBeenCalled();
  }
);
it('changed registered destination root refuses discovery and proof recovery despite an APPLIED move', async () => {
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
  const rename = vi.spyOn(fs, 'rename');
  await expect(f.discover()).rejects.toThrow();
  await expect(f.recover()).rejects.toThrow();
  expect(f.row().status).toBe('in_doubt');
  expect(f.h.http.channels.getEvent(f.documentId, f.input.documentSave.eventId)).toBeUndefined();
  expect(rename).not.toHaveBeenCalled();
});
