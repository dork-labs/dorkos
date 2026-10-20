/** The real current operator/source, FILE SQLite intent, original replacement and host receipt. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { initConfigManager } from '../../../../core/config-manager.js';
import {
  assertFileSaveAdmission,
  FileSaveWriteFencedError,
  readFileSaveIntent,
  validateFileSaveIntent,
} from '../file-save-intents.js';
import { readChecked } from '../../store-json.js';
import { join } from 'node:path';
import { controlUi } from '../../../../session/browser-seat/ui-control.js';
import { and, eq, sql, canvasDocuments, canvasDocFileSaveIntents } from '@dorkos/db';
import { FileDocumentSaveReceiptSchema } from '@dorkos/shared/schemas';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { initBoundary } from '../../../../../lib/boundary.js';
import { fixture } from './checkbox-fixture.js';
import { readSessionDocSourceDescriptor } from '../../doc-source-policy.js';
import { docDocumentGeneration } from '../../identity/incarnation.js';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import { createFileRoutes } from '../../../../../routes/files.js';
import { saveOriginalDocumentFile } from '../installation-file-writes.js';

const target = swappableServer();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const h = await fixture();
  cleanups.push(h.cleanup);
  await initBoundary(h.dir);
  cleanups.push(() => h.http.fileWrites.stop());
  const source = readSessionDocSourceDescriptor(
    { db: h.db, documents: h.rooms.canvasDocuments },
    h.documentId
  );
  const channel = h.http.channels.getChannel(h.documentId)!;
  const snapshot = await h.http.service.replay(h.documentId, h.actor);
  const incarnation = CanvasDocIncarnationSchema.parse(snapshot.incarnation);
  expect(incarnation).toMatchObject({
    documentId: source.id,
    physicalOpenedAt: source.openedAt,
    channelCreatedAt: channel.createdAt,
    generation: docDocumentGeneration(source, channel),
  });
  const before = await fs.readFile(h.path, 'utf8');
  const request = (content = 'saved through the original writer') => ({
    cwd: h.dir,
    path: h.path,
    content,
    expectedContent: before,
    documentSave: { documentId: h.documentId, eventId: randomUUID(), incarnation },
  });
  const save = (input: ReturnType<typeof request>, headers: Record<string, string> = {}) =>
    saveOriginalDocumentFile(h.http.fileWrites, input, { headers });
  const intent = (eventId: string) =>
    h.db
      .select()
      .from(canvasDocFileSaveIntents)
      .where(
        and(
          eq(canvasDocFileSaveIntents.documentId, h.documentId),
          eq(canvasDocFileSaveIntents.eventId, eventId)
        )
      )
      .get();
  const failReceipt = () =>
    h.db.run(
      sql`CREATE TRIGGER refuse_original_saved_receipt BEFORE INSERT ON canvas_doc_events WHEN NEW.type='doc.saved' BEGIN SELECT RAISE(ABORT,'saved receipt unavailable'); END`
    );
  const allowReceipt = () => h.db.run(sql`DROP TRIGGER refuse_original_saved_receipt`);
  return { h, source, incarnation, before, request, save, intent, failReceipt, allowReceipt };
}
function receipt(body: unknown) {
  return FileDocumentSaveReceiptSchema.parse(
    (body as { documentReceipt?: unknown }).documentReceipt
  );
}

it('returns one genuine receipt only after the original replacement and owning transaction commit', async () => {
  const f = await setup(),
    input = f.request();
  const result = await f.save(input);
  expect(result.status).toBe(200);
  const saved = receipt(result.body);
  expect(saved).toMatchObject({
    documentId: f.h.documentId,
    eventId: input.documentSave.eventId,
    incarnation: f.incarnation,
    status: 'accepted',
  });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(input.content);
  expect(f.intent(saved.eventId)).toMatchObject({ status: 'committed', docSeq: saved.docSeq });
  expect(f.h.http.channels.getEvent(f.h.documentId, saved.eventId)).toMatchObject({
    type: 'doc.saved',
    direction: 'system',
    docSeq: saved.docSeq,
  });
  expect(f.h.http.channels.listDeliveries(f.h.documentId, saved.eventId)).toEqual([]);
});

it('identical uncertain-response retry returns the original receipt without another rename', async () => {
  const f = await setup(),
    input = f.request();
  const renames = vi.spyOn(fs, 'rename');
  const first = receipt((await f.save(input)).body);
  const duplicate = receipt((await f.save(input)).body);
  expect(duplicate).toEqual({ ...first, status: 'duplicate' });
  expect(renames.mock.calls.filter(([, target]) => target === f.h.path)).toHaveLength(1);
});

it('a completed receipt remains an acknowledgement of that operation after a later ordinary save', async () => {
  const f = await setup(),
    input = f.request();
  const first = receipt((await f.save(input)).body);
  await f.h.http.fileWrites.save({ cwd: f.h.dir, path: f.h.path, content: 'later ordinary bytes' });
  const duplicate = receipt((await f.save(input)).body);
  expect(duplicate).toEqual({ ...first, status: 'duplicate' });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe('later ordinary bytes');
});

it('changed bytes under an existing operation UUID refuse without another effect', async () => {
  const f = await setup(),
    input = f.request();
  await f.save(input);
  await expect(f.save({ ...input, content: 'different operation' })).rejects.toMatchObject({
    code: 'DOC_SAVE_ID_CONFLICT',
  });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(input.content);
});

it('an actual replacement followed by failed receipt storage recovers from its original inode, never replaying the write', async () => {
  const f = await setup(),
    input = f.request();
  const renames = vi.spyOn(fs, 'rename');
  f.failReceipt();
  await expect(f.save(input)).rejects.toThrow('saved receipt unavailable');
  const held = f.intent(input.documentSave.eventId)!;
  expect(held.status).toBe('in_doubt');
  expect(held.replacementInode).not.toBeNull();
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(input.content);
  expect(f.h.http.channels.getEvent(f.h.documentId, input.documentSave.eventId)).toBeUndefined();
  await expect(
    f.h.http.fileWrites.save({ cwd: f.h.dir, path: f.h.path, content: 'cannot bypass uncertainty' })
  ).rejects.toThrow();
  f.allowReceipt();
  const recovered = receipt((await f.save(input)).body);
  expect(recovered.status).toBe('duplicate');
  expect(f.intent(recovered.eventId)).toMatchObject({
    status: 'committed',
    docSeq: recovered.docSeq,
  });
  expect(renames.mock.calls.filter(([, target]) => target === f.h.path)).toHaveLength(1);
});

it('same after-bytes on another inode cannot be promoted into an original replacement receipt', async () => {
  const f = await setup(),
    input = f.request();
  f.failReceipt();
  await expect(f.save(input)).rejects.toThrow();
  const foreign = `${f.h.path}.foreign`;
  await fs.writeFile(foreign, input.content);
  await fs.rename(foreign, f.h.path);
  f.allowReceipt();
  await expect(f.save(input)).rejects.toMatchObject({ code: 'DOC_SAVE_IN_DOUBT' });
  expect(f.h.http.channels.getEvent(f.h.documentId, input.documentSave.eventId)).toBeUndefined();
  expect(f.intent(input.documentSave.eventId)!.status).toBe('in_doubt');
});

it('a no-op reserves correlation but never manufactures a saved event or receipt', async () => {
  const f = await setup(),
    input = f.request(f.before);
  const result = await f.save(input);
  expect(result.body).not.toHaveProperty('documentReceipt');
  expect(f.intent(input.documentSave.eventId)!.status).toBe('no_op');
  expect(f.h.http.channels.getEvent(f.h.documentId, input.documentSave.eventId)).toBeUndefined();
  await expect(
    f.h.http.service.ingestEvent(
      f.h.documentId,
      { v: 1, id: input.documentSave.eventId, type: 'ui.click', payload: null },
      f.h.actor
    )
  ).rejects.toThrow();
});

it('an existing public event UUID blocks ordinary preparation before a file effect', async () => {
  const f = await setup(),
    input = f.request();
  await f.h.http.service.ingestEvent(
    f.h.documentId,
    { v: 1, id: input.documentSave.eventId, type: 'ui.click', payload: null },
    f.h.actor
  );
  await expect(f.save(input)).rejects.toThrow();
  expect(f.intent(input.documentSave.eventId)).toBeUndefined();
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(f.before);
});

it('a different current document incarnation cannot settle an earlier uncertain save', async () => {
  const f = await setup(),
    input = f.request();
  f.failReceipt();
  await expect(f.save(input)).rejects.toThrow();
  f.allowReceipt();
  f.h.db
    .update(canvasDocuments)
    .set({ openedAt: new Date(Date.parse(f.incarnation.physicalOpenedAt) + 1000).toISOString() })
    .where(eq(canvasDocuments.id, f.h.documentId))
    .run();
  await expect(f.save(input)).rejects.toMatchObject({ code: 'CANVAS_DOCUMENT_NOT_FOUND' });
  expect(f.h.http.channels.getEvent(f.h.documentId, input.documentSave.eventId)).toBeUndefined();
});

it('current document authorization does not permit saving a different path with the same bytes', async () => {
  const f = await setup(),
    input = f.request();
  const other = `${f.h.path}.other`;
  await fs.writeFile(other, f.before);
  await expect(f.save({ ...input, path: other })).rejects.toMatchObject({
    code: 'CANVAS_DOCUMENT_NOT_FOUND',
  });
  expect(await fs.readFile(other, 'utf8')).toBe(f.before);
  expect(f.intent(input.documentSave.eventId)).toBeUndefined();
});

it('agent headers cannot borrow the operator save lane', async () => {
  const f = await setup(),
    input = f.request();
  await expect(f.save(input, { 'x-dorkos-agent': 'unverified' })).rejects.toMatchObject({
    code: 'CANVAS_DOCUMENT_NOT_FOUND',
  });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(f.before);
  expect(f.intent(input.documentSave.eventId)).toBeUndefined();
});

it('SQLite refuses a committed intent without a real sequence', async () => {
  const f = await setup(),
    input = f.request();
  f.failReceipt();
  await expect(f.save(input)).rejects.toThrow();
  expect(() =>
    f.h.db
      .update(canvasDocFileSaveIntents)
      .set({ status: 'committed', docSeq: null })
      .where(eq(canvasDocFileSaveIntents.eventId, input.documentSave.eventId))
      .run()
  ).toThrow();
});

it('a proven pre-effect open failure releases the file fence without reusing its failed operation', async () => {
  const f = await setup(),
    input = f.request();
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    if (typeof args[0] === 'string' && args[0].endsWith('.tmp'))
      throw Object.assign(new Error('denied before creation'), { code: 'EACCES' });
    return open(...args);
  }) as typeof fs.open);
  await expect(f.save(input)).rejects.toThrow('denied before creation');
  expect(f.intent(input.documentSave.eventId)).toMatchObject({
    status: 'failed',
    replacementInode: null,
  });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(f.before);
  vi.restoreAllMocks();
  await f.h.http.fileWrites.save({ cwd: f.h.dir, path: f.h.path, content: 'a later operation' });
  await expect(f.save(input)).rejects.toMatchObject({ code: 'DOC_SAVE_FAILED' });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe('a later operation');
});

it('retirement at the last awaited pre-effect check prevents the target replacement', async () => {
  const f = await setup(),
    input = f.request();
  const lstat = fs.lstat;
  let temporaryChecks = 0;
  vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const value = await lstat(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('.tmp') && ++temporaryChecks === 2) {
      f.h.db.run(
        sql`UPDATE canvas_doc_channels SET closed_at=${new Date().toISOString()} WHERE document_id=${f.h.documentId}`
      );
    }
    return value;
  }) as typeof fs.lstat);
  await expect(f.save(input)).rejects.toMatchObject({ code: 'CANVAS_DOCUMENT_NOT_FOUND' });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(f.before);
  expect(f.h.http.channels.getEvent(f.h.documentId, input.documentSave.eventId)).toBeUndefined();
});

it('a replaced public plain-save method cannot manufacture the original document receipt', async () => {
  const f = await setup(),
    input = f.request();
  const fake = vi
    .spyOn(f.h.http.fileWrites, 'save')
    .mockRejectedValue(new Error('public method replaced'));
  const result = await f.save(input);
  expect(receipt(result.body).status).toBe('accepted');
  expect(fake).not.toHaveBeenCalled();
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(input.content);
});

it('the real ordinary PUT route exposes receipt refusals as 404 and 412 rather than generic failures', async () => {
  const f = await setup(),
    input = f.request();
  // The real host/auth middleware reads its normal boot singleton; keep its config inside this owned fixture.
  initConfigManager(f.h.dir);
  target.mount(
    honoGroupListener({ path: '/api/files', routes: createFileRoutes(f.h.http.fileWrites) })
  );
  const saved = await request(target.server).put('/api/files/content').send(input);
  expect(saved.status).toBe(200);
  expect(receipt(saved.body)).toMatchObject({
    eventId: input.documentSave.eventId,
    status: 'accepted',
  });
  const conflict = await request(target.server)
    .put('/api/files/content')
    .send({ ...input, content: 'changed UUID request' });
  expect(conflict.status).toBe(412);
  expect(conflict.body.code).toBe('DOC_SAVE_ID_CONFLICT');
  const missing = randomUUID();
  const refused = await request(target.server)
    .put('/api/files/content')
    .send({
      ...input,
      documentSave: {
        ...input.documentSave,
        documentId: missing,
        incarnation: { ...input.documentSave.incarnation, documentId: missing },
      },
    });
  expect(refused.status).toBe(404);
  expect(refused.body.code).toBe('CANVAS_DOCUMENT_NOT_FOUND');
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(input.content);
});

/** Exercise the actual Main opener; no manufactured tree placement enters this document. */
async function openThroughProductionSession(f: Awaited<ReturnType<typeof setup>>) {
  const path = join(f.h.dir, 'ordinary-production-file.txt');
  const content = 'production session baseline';
  await fs.writeFile(path, content, { flag: 'wx' });
  const opened = await controlUi(
    {
      action: 'open_canvas',
      content: { type: 'file', title: 'Production save file', sourcePath: path },
    },
    { sessionId: 'session-a', cwd: f.h.dir, principal: f.h.runtime.principal }
  );
  expect(opened).toMatchObject({ success: true, target: 'session' });
  if (typeof opened.documentId !== 'string') throw new Error('Production file document missing');
  const physical = f.h.db
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, opened.documentId))
    .get()!;
  expect(physical).toMatchObject({ resolvedCwd: f.h.dir, treeKind: null });
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await f.h.http.service.replay(opened.documentId, f.h.actor)).incarnation
  );
  const input = {
    cwd: f.h.dir,
    path,
    content: 'real production saved bytes',
    expectedContent: content,
    documentSave: { documentId: opened.documentId, eventId: randomUUID(), incarnation },
  };
  return { path, content, input };
}
it('the genuine production session FILE opener can save and record its original receipt with the existing null tree label', async () => {
  const f = await setup(),
    current = await openThroughProductionSession(f);
  const result = await f.save(current.input);
  expect(result.status).toBe(200);
  const saved = receipt(result.body);
  expect(saved).toMatchObject({
    documentId: current.input.documentSave.documentId,
    eventId: current.input.documentSave.eventId,
    status: 'accepted',
  });
  expect(await fs.readFile(current.path, 'utf8')).toBe(current.input.content);
  expect(f.h.http.channels.getEvent(saved.documentId, saved.eventId)).toMatchObject({
    type: 'doc.saved',
    direction: 'system',
    docSeq: saved.docSeq,
  });
});
it('a null tree with no captured physical cwd remains unavailable, even for an otherwise current session and existing file', async () => {
  const f = await setup(),
    path = join(f.h.dir, 'person-opened-no-tree.txt');
  await fs.writeFile(path, 'unchanged', { flag: 'wx' });
  const doc = f.h.rooms.canvas.open('session:session-a', 'owner', {
    type: 'file',
    title: 'No tree evidence',
    sourcePath: path,
  });
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await f.h.http.service.replay(doc.id, f.h.actor)).incarnation
  );
  const input = {
    cwd: f.h.dir,
    path,
    content: 'must not write',
    expectedContent: 'unchanged',
    documentSave: { documentId: doc.id, eventId: randomUUID(), incarnation },
  };
  await expect(f.save(input)).rejects.toThrow();
  expect(await fs.readFile(path, 'utf8')).toBe('unchanged');
  expect(f.h.http.channels.getEvent(doc.id, input.documentSave.eventId)).toBeUndefined();
});
it('a null session tree cannot substitute another captured cwd for the registered session root', async () => {
  const f = await setup(),
    current = await openThroughProductionSession(f);
  const other = join(f.h.dir, 'different-tree');
  await fs.mkdir(other);
  f.h.db
    .update(canvasDocuments)
    .set({ resolvedCwd: other })
    .where(eq(canvasDocuments.id, current.input.documentSave.documentId))
    .run();
  await expect(f.save(current.input)).rejects.toThrow();
  expect(await fs.readFile(current.path, 'utf8')).toBe(current.content);
  expect(
    f.h.http.channels.getEvent(
      current.input.documentSave.documentId,
      current.input.documentSave.eventId
    )
  ).toBeUndefined();
});

it('genuine uncertain ordinary evidence permits null sequence while retaining its exact physical-file fence', async () => {
  const f = await setup(),
    input = f.request();
  f.failReceipt();
  await expect(f.save(input)).rejects.toThrow('saved receipt unavailable');
  const held = readFileSaveIntent(f.h.db, f.h.documentId, input.documentSave.eventId)!;
  expect(held).toMatchObject({ status: 'in_doubt', docSeq: null });
  const physical = await fs.stat(f.h.path, { bigint: true });
  const identity = {
    canonicalPath: await fs.realpath(f.h.path),
    device: String(physical.dev),
    inode: String(physical.ino),
  };
  expect(() => assertFileSaveAdmission(f.h.db, identity)).toThrow('unresolved original save');
  expect(() => assertFileSaveAdmission(f.h.db, identity, held.intentId)).not.toThrow();
  expect(() => f.h.service.writeFence.assertAdmission(identity)).toThrow(FileSaveWriteFencedError);
  expect(() => f.h.service.writeFence.assertAdmission(identity, held.intentId)).not.toThrow();
  expect(f.h.http.channels.getEvent(f.h.documentId, input.documentSave.eventId)).toBeUndefined();
});
it('table-specific nullable phases never admit invalid or unsafe sequence evidence, and the generic guard remains strict', async () => {
  const f = await setup(),
    input = f.request();
  f.failReceipt();
  await expect(f.save(input)).rejects.toThrow('saved receipt unavailable');
  const held = f.intent(input.documentSave.eventId)!;
  const prepared = {
    ...held,
    status: 'prepared',
    replacementDevice: null,
    replacementInode: null,
    docSeq: null,
  };
  expect(validateFileSaveIntent(prepared)).toMatchObject({ status: 'prepared', docSeq: null });
  expect(() => validateFileSaveIntent({ ...prepared, docSeq: 1 })).toThrow('Invalid stored');
  for (const docSeq of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', NaN, Infinity])
    expect(() => validateFileSaveIntent({ ...held, status: 'committed', docSeq })).toThrow(
      'Invalid stored'
    );
  expect(() => validateFileSaveIntent({ ...held, status: 'unknown' })).toThrow('Invalid stored');
  expect(() =>
    readChecked('canvas_doc_events', 'unchanged-global-sequence-rule', () => ({ docSeq: null }))
  ).toThrow('Invalid stored');
});
it('malformed persisted JSON still fails closed on both original UUID lookup and unresolved admission', async () => {
  const f = await setup(),
    input = f.request();
  f.failReceipt();
  await expect(f.save(input)).rejects.toThrow('saved receipt unavailable');
  f.h.db.run(
    sql`UPDATE canvas_doc_file_save_intents SET source='{' WHERE event_id=${input.documentSave.eventId}`
  );
  expect(() => readFileSaveIntent(f.h.db, f.h.documentId, input.documentSave.eventId)).toThrow(
    'Invalid stored document channel record'
  );
  const physical = await fs.stat(f.h.path, { bigint: true });
  expect(() =>
    assertFileSaveAdmission(f.h.db, {
      canonicalPath: f.h.path,
      device: String(physical.dev),
      inode: String(physical.ino),
    })
  ).toThrow('Invalid stored document channel record');
});
