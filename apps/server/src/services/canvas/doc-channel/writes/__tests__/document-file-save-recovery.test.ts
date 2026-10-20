/** Genuine FILE SQLite, installation-owned current session source and proof-only receipt recovery. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, sql, canvasDocFileSaveIntents, canvasDocBatches, canvasDocuments } from '@dorkos/db';
import {
  CanvasChannelReplayResponseSchema,
  CanvasDocIncarnationSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { FileDocumentSaveReceiptSchema } from '@dorkos/shared/schemas';
import {
  FileSaveDiscoverySchema,
  FileSaveRecoverResultSchema,
} from '@dorkos/shared/file-save/recovery';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import {
  createCanvasDocEventRoutes,
  canvasDocBodyRule,
} from '../../../../../routes/canvas-doc-events.js';
import { initBoundary } from '../../../../../lib/boundary.js';
import { controlUi } from '../../../../session/browser-seat/ui-control.js';
import { initConfigManager } from '../../../../core/config-manager.js';
import { setCanvasService } from '../../../index.js';
import { setRoomService } from '../../../../rooms/index.js';
import { DocumentFileSaveCloseBlockedError } from '../file-save-lifecycle/close-guard.js';
import { DocChannelNotFoundError } from '../../authorization.js';
import { authorityFixture } from './authority-fixtures.js';
import {
  saveOriginalDocumentFile,
  discoverOriginalDocumentFileSaves,
  recoverOriginalDocumentFileSave,
} from '../installation-file-writes.js';
import { validateFileSaveIntent } from '../file-save-intents.js';
const server = swappableServer();
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
  initConfigManager(h.dir);
  setRoomService(h.rooms.service);
  setCanvasService(h.rooms.canvas);
  const route = {
    id: 'saved',
    on: 'doc.saved',
    to: 'agent:owner' as const,
    turn: { mode: 'immediate' as const, maxBatch: 1 },
  };
  h.http.grants.configure(h.input.documentId, { routes: [route] }, h.actor);
  const grantInput = {
    documentId: h.input.documentId,
    routeId: route.id,
    allowedTypes: ['doc.saved'],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const pending = h.http.grants.grant(grantInput, h.actor);
  if (pending.kind !== 'approval_required') throw new Error('Expected genuine operator approval');
  h.approvals.grant(pending.ticket.approvalId);
  const grant = h.http.grants.grant(grantInput, h.actor, pending.ticket.token);
  if (grant.kind !== 'granted') throw new Error('Expected original grant');
  const documentId = h.input.documentId;
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await h.http.service.replay(documentId, h.actor)).incarnation
  );
  const before = await fs.readFile(h.path, 'utf8');
  const input = (content = 'Saved original bytes') => ({
    cwd: h.dir,
    path: h.path,
    content,
    expectedContent: before,
    documentSave: { documentId, eventId: randomUUID(), incarnation },
  });
  const save = (value: ReturnType<typeof input>) =>
    saveOriginalDocumentFile(h.http.fileWrites, value, { headers: {} });
  const discover = () =>
    discoverOriginalDocumentFileSaves(h.http.fileWrites, documentId, { headers: {} });
  const recover = (eventId: string) =>
    recoverOriginalDocumentFileSave(
      h.http.fileWrites,
      { documentId, eventId, expectedIncarnation: incarnation },
      { headers: {} }
    );
  const intent = (eventId: string) =>
    h.db
      .select()
      .from(canvasDocFileSaveIntents)
      .where(eq(canvasDocFileSaveIntents.eventId, eventId))
      .get()!;
  const batches = () => h.db.select().from(canvasDocBatches).all();
  const fail = () =>
    h.db.run(
      sql`CREATE TRIGGER refuse_recovery_receipt BEFORE INSERT ON canvas_doc_events WHEN NEW.type='doc.saved' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`
    );
  const allow = () => h.db.run(sql`DROP TRIGGER refuse_recovery_receipt`);
  server.mount(
    honoGroupListener(
      { path: '/api/canvas/docs', routes: createCanvasDocEventRoutes(() => h.http) },
      { bodyRules: [canvasDocBodyRule(() => undefined)] }
    )
  );
  const endpoint = `/api/canvas/docs/${encodeURIComponent(documentId)}/file-saves`;
  return {
    h,
    documentId,
    incarnation,
    before,
    input,
    save,
    discover,
    recover,
    intent,
    batches,
    fail,
    allow,
    endpoint,
  };
}
it('cold authenticated replay carries the original saved frame birth before receipt discovery', async () => {
  const f = await setup(),
    input = f.input();
  await f.save(input);
  const original = f.intent(input.documentSave.eventId),
    batches = f.batches();
  const rename = vi.spyOn(fs, 'rename'),
    write = vi.spyOn(fs, 'writeFile');
  const response = await request(server.server)
    .get(`/api/canvas/docs/${encodeURIComponent(f.documentId)}/channel?since=0&limit=200`)
    .expect(200);
  const replay = CanvasChannelReplayResponseSchema.parse(response.body);
  expect(replay.incarnation).toEqual(f.incarnation);
  expect(replay.events).toHaveLength(1);
  expect(replay.events[0]).toMatchObject({
    type: 'canvas_event',
    documentId: f.documentId,
    incarnation: f.incarnation,
    docSeq: original.docSeq,
    event: { id: input.documentSave.eventId, type: 'doc.saved', direction: 'system' },
  });
  const discovery = FileSaveDiscoverySchema.parse(
    (await request(server.server).get(f.endpoint).expect(200)).body
  );
  expect(discovery.entries[0]).toMatchObject({
    eventId: input.documentSave.eventId,
    state: 'receipt',
    receipt: { incarnation: replay.events[0]!.incarnation, docSeq: original.docSeq },
  });
  expect(f.intent(input.documentSave.eventId)).toEqual(original);
  expect(f.batches()).toEqual(batches);
  expect(rename).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it('discovers committed proof without the original draft, UUID knowledge or another outbox effect', async () => {
  const f = await setup(),
    input = f.input();
  const first = await f.save(input);
  const unknownReceipt = 'documentReceipt' in first.body ? first.body.documentReceipt : undefined;
  if (!unknownReceipt) throw new Error('Original receipt missing');
  const accepted = FileDocumentSaveReceiptSchema.parse(unknownReceipt);
  const before = f.batches();
  const response = await request(server.server).get(f.endpoint).expect(200);
  const result = FileSaveDiscoverySchema.parse(response.body);
  expect(result.entries).toEqual([
    expect.objectContaining({
      eventId: input.documentSave.eventId,
      state: 'receipt',
      historical: true,
      currentFileMatch: 'not_checked',
      receipt: expect.objectContaining({ docSeq: accepted.docSeq, status: 'duplicate' }),
    }),
  ]);
  expect(f.batches()).toEqual(before);
  expect(result.hasMore).toBe(false);
  const wire = JSON.stringify(result);
  for (const secret of [
    input.content,
    f.h.dir,
    f.h.path,
    'canonicalPath',
    'replacementInode',
    'routing',
    'approvalToken',
  ])
    expect(wire).not.toContain(secret);
});
it('recovers a staged original replacement exactly once without any file write, rename or new routes', async () => {
  const f = await setup(),
    input = f.input();
  f.fail();
  await expect(f.save(input)).rejects.toThrow('receipt unavailable');
  f.allow();
  const physical = await fs.stat(f.h.path, { bigint: true });
  const rename = vi.spyOn(fs, 'rename'),
    write = vi.spyOn(fs, 'writeFile');
  const first = FileSaveRecoverResultSchema.parse(await f.recover(input.documentSave.eventId));
  expect(first.entry).toMatchObject({
    state: 'receipt',
    currentFileMatch: 'same_saved_replacement',
    receipt: { eventId: input.documentSave.eventId },
  });
  const originalBatches = f.batches();
  expect(originalBatches).toHaveLength(0);
  const duplicate = await f.recover(input.documentSave.eventId);
  expect(duplicate.entry).toMatchObject({
    state: 'receipt',
    receipt: first.entry.state === 'receipt' ? first.entry.receipt : {},
  });
  expect(f.batches()).toEqual(originalBatches);
  expect(rename).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  const after = await fs.stat(f.h.path, { bigint: true });
  expect([after.dev, after.ino]).toEqual([physical.dev, physical.ino]);
});
it('returns historical committed proof separately from a later writer’s different file', async () => {
  const f = await setup(),
    input = f.input();
  await f.save(input);
  await fs.writeFile(f.h.path, 'Later external bytes');
  const result = await f.recover(input.documentSave.eventId);
  expect(result.entry).toMatchObject({
    state: 'receipt',
    historical: true,
    currentFileMatch: 'different',
    receipt: { fileHash: f.intent(input.documentSave.eventId).afterHash },
  });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe('Later external bytes');
});
it('does not settle same bytes placed into a different inode by another writer', async () => {
  const f = await setup(),
    input = f.input();
  f.fail();
  await expect(f.save(input)).rejects.toThrow();
  f.allow();
  const temporary = join(f.h.dir, 'foreign-replacement');
  await fs.writeFile(temporary, input.content);
  await fs.rename(temporary, f.h.path);
  const rename = vi.spyOn(fs, 'rename');
  const result = await f.recover(input.documentSave.eventId);
  expect(result.entry).toMatchObject({ state: 'review', reason: 'replacement_not_proven' });
  expect(f.intent(input.documentSave.eventId).status).toBe('in_doubt');
  expect(f.batches()).toHaveLength(0);
  expect(rename).not.toHaveBeenCalled();
});
it('keeps a simulated prepared crash without staged identity fenced for manual review', async () => {
  const f = await setup(),
    input = f.input();
  f.fail();
  await expect(f.save(input)).rejects.toThrow();
  f.allow();
  // Retain the genuine original immutable request/owner/source, simulating the earlier durable phase.
  f.h.db
    .update(canvasDocFileSaveIntents)
    .set({ status: 'prepared', docSeq: null, replacementDevice: null, replacementInode: null })
    .where(eq(canvasDocFileSaveIntents.eventId, input.documentSave.eventId))
    .run();
  const result = await f.recover(input.documentSave.eventId);
  expect(result.entry).toMatchObject({ state: 'review', reason: 'prepared_without_replacement' });
  expect(f.intent(input.documentSave.eventId).status).toBe('prepared');
  expect((await f.discover()).admission).toBe('blocked');
  expect(f.batches()).toHaveLength(0);
});
it('recovers only original history even while an actual doc.saved route is approved', async () => {
  const f = await setup(),
    input = f.input();
  f.fail();
  await expect(f.save(input)).rejects.toThrow();
  f.allow();
  const result = await f.recover(input.documentSave.eventId);
  expect(result.entry.state).toBe('receipt');
  expect(f.batches()).toHaveLength(0);
  expect(f.h.http.channels.listDeliveries(f.documentId, input.documentSave.eventId)).toEqual([]);
  expect(f.h.http.channels.getEvent(f.documentId, input.documentSave.eventId)?.type).toBe(
    'doc.saved'
  );
});
it('never selects a newly approved route during historical original receipt recovery', async () => {
  const f = await setup(),
    input = f.input();
  f.fail();
  await expect(f.save(input)).rejects.toThrow();
  f.allow();
  f.h.http.grants.configure(
    f.documentId,
    {
      routes: [
        {
          id: 'new-route',
          on: 'doc.saved',
          to: 'agent:owner',
          turn: { mode: 'immediate', maxBatch: 1 },
        },
      ],
    },
    f.h.actor
  );
  const grantInput = {
    documentId: f.documentId,
    routeId: 'new-route',
    allowedTypes: ['doc.saved'],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const pending = f.h.http.grants.grant(grantInput, f.h.actor);
  if (pending.kind !== 'approval_required') throw new Error('Expected actual approval');
  f.h.approvals.grant(pending.ticket.approvalId);
  f.h.http.grants.grant(grantInput, f.h.actor, pending.ticket.token);
  await f.recover(input.documentSave.eventId);
  expect(f.batches()).toHaveLength(0);
  expect(f.h.http.channels.listDeliveries(f.documentId, input.documentSave.eventId)).toEqual([]);
});
it('returns no-op and proven failure honestly without manufacturing saved events', async () => {
  const f = await setup(),
    input = f.input(f.before);
  await f.save(input);
  const noOp = await f.recover(input.documentSave.eventId);
  expect(noOp.entry.state).toBe('no_op');
  f.h.db
    .update(canvasDocFileSaveIntents)
    .set({ status: 'failed' })
    .where(eq(canvasDocFileSaveIntents.eventId, input.documentSave.eventId))
    .run();
  expect((await f.recover(input.documentSave.eventId)).entry.state).toBe('failed');
  expect(f.batches()).toHaveLength(0);
});
it('bounds recent matching owner/birth summaries and never treats the window as vacancy proof', async () => {
  const f = await setup();
  for (let i = 0; i < 27; i++) await f.save(f.input(f.before));
  const result = await f.discover();
  expect(result.entries).toHaveLength(25);
  expect(result.hasMore).toBe(true);
  expect(result.window).toBe('latest_25_current_owner_birth');
});
it('reports an older-birth alias blocker without disclosing its UUID or allowing settlement', async () => {
  const f = await setup(),
    input = f.input(f.before);
  await f.save(input);
  const original = validateFileSaveIntent(f.intent(input.documentSave.eventId));
  const foreignId = randomUUID();
  f.h.db
    .insert(canvasDocFileSaveIntents)
    .values({
      ...original,
      intentId: randomUUID(),
      eventId: foreignId,
      status: 'prepared',
      incarnation: { ...original.incarnation, generation: 'b'.repeat(64) },
    })
    .run();
  const result = await f.discover();
  expect(result.admission).toBe('blocked');
  expect(JSON.stringify(result)).not.toContain(foreignId);
  await expect(f.recover(foreignId)).rejects.toThrow();
});
it('refuses malformed unknown durable phase instead of returning an empty or clear discovery', async () => {
  const f = await setup(),
    input = f.input(f.before);
  await f.save(input);
  // Simulate persisted corruption explicitly; production CHECK constraints remain unchanged.
  f.h.db.run(sql`PRAGMA ignore_check_constraints=ON`);
  try {
    f.h.db.run(
      sql`UPDATE canvas_doc_file_save_intents SET status='unrecognized' WHERE event_id=${input.documentSave.eventId}`
    );
  } finally {
    f.h.db.run(sql`PRAGMA ignore_check_constraints=OFF`);
  }
  await request(server.server).get(f.endpoint).expect(503);
  expect(f.intent(input.documentSave.eventId).status).toBe('unrecognized');
});
it('rejects stale full birth, foreign document, presented agent/bearer and foreign owner before disclosing original rows', async () => {
  const f = await setup(),
    input = f.input();
  await f.save(input);
  await request(server.server)
    .post(`${f.endpoint}/${input.documentSave.eventId}/recover`)
    .send({ expectedIncarnation: { ...f.incarnation, generation: 'b'.repeat(64) } })
    .expect(404);
  await expect(
    discoverOriginalDocumentFileSaves(f.h.http.fileWrites, 'foreign-document', { headers: {} })
  ).rejects.toThrow();
  await expect(
    discoverOriginalDocumentFileSaves(f.h.http.fileWrites, f.documentId, {
      headers: { 'x-dorkos-agent': 'presented' },
    })
  ).rejects.toThrow();
  await expect(
    discoverOriginalDocumentFileSaves(f.h.http.fileWrites, f.documentId, {
      headers: { authorization: 'Bearer dct_scoped' },
    })
  ).rejects.toThrow();
  await expect(
    discoverOriginalDocumentFileSaves(f.h.http.fileWrites, f.documentId, {
      headers: {},
      user: { userId: 'foreign', credential: 'cookie' },
    })
  ).rejects.toThrow();
});
it('accepts only full-birth recovery body and no arbitrary path/content/principal/query input', async () => {
  const f = await setup(),
    input = f.input();
  await f.save(input);
  await request(server.server)
    .post(`${f.endpoint}/${input.documentSave.eventId}/recover`)
    .send({
      expectedIncarnation: f.incarnation,
      content: 'forged',
      path: '/foreign',
      principal: { kind: 'operator' },
    })
    .expect(400);
  await request(server.server).get(`${f.endpoint}?path=/foreign`).expect(400);
});
it('refuses changed registered source and stop/drain admission without clearing original evidence', async () => {
  const f = await setup(),
    input = f.input();
  await f.save(input);
  f.h.db
    .update(canvasDocuments)
    .set({ content: { type: 'file', title: 'Changed source', sourcePath: 'other.md' } })
    .where(eq(canvasDocuments.id, f.documentId))
    .run();
  await expect(f.recover(input.documentSave.eventId)).rejects.toThrow();
  expect(f.intent(input.documentSave.eventId).status).toBe('committed');
  await f.h.http.fileWrites.stop();
  await expect(f.discover()).rejects.toThrow('stopped');
});

it('discovers and recovers the actual production controlUi FILE with null tree without inventing tree placement', async () => {
  const f = await setup();
  const path = join(f.h.dir, 'production-null-tree.txt');
  await fs.writeFile(path, 'original', { flag: 'wx' });
  const opened = await controlUi(
    {
      action: 'open_canvas',
      content: { type: 'file', title: 'Production ordinary file', sourcePath: path },
    },
    { sessionId: 'session-a', cwd: f.h.dir, principal: f.h.runtime.principal }
  );
  if (typeof opened.documentId !== 'string') throw new Error('Production document missing');
  const physical = f.h.db
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, opened.documentId))
    .get()!;
  expect(physical.treeKind).toBe(null);
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await f.h.http.service.replay(opened.documentId, f.h.actor)).incarnation
  );
  const eventId = randomUUID();
  await saveOriginalDocumentFile(
    f.h.http.fileWrites,
    {
      cwd: f.h.dir,
      path,
      content: 'saved',
      expectedContent: 'original',
      documentSave: { documentId: opened.documentId, eventId, incarnation },
    },
    { headers: {} }
  );
  const found = await discoverOriginalDocumentFileSaves(f.h.http.fileWrites, opened.documentId, {
    headers: {},
  });
  expect(found.entries).toEqual([expect.objectContaining({ eventId, state: 'receipt' })]);
  const result = await recoverOriginalDocumentFileSave(
    f.h.http.fileWrites,
    { documentId: opened.documentId, eventId, expectedIncarnation: incarnation },
    { headers: {} }
  );
  expect(result.entry).toMatchObject({
    state: 'receipt',
    currentFileMatch: 'same_saved_replacement',
  });
});

it('refuses a genuinely unplaced session FILE rather than treating null tree alone as sufficient', async () => {
  const f = await setup();
  const path = join(f.h.dir, 'unplaced.txt');
  await fs.writeFile(path, 'not disclosed', { flag: 'wx' });
  const doc = f.h.rooms.canvas.open('session:session-a', 'owner', {
    type: 'file',
    title: 'No tree',
    sourcePath: path,
  });
  await expect(
    discoverOriginalDocumentFileSaves(f.h.http.fileWrites, doc.id, { headers: {} })
  ).rejects.toThrow();
});
it('refuses registered session root/captured cwd mismatch before discovery', async () => {
  const f = await setup();
  const other = join(f.h.dir, 'other-root');
  await fs.mkdir(other);
  f.h.db
    .update(canvasDocuments)
    .set({ resolvedCwd: other })
    .where(eq(canvasDocuments.id, f.documentId))
    .run();
  await expect(f.discover()).rejects.toThrow();
});
it('refuses a real Room FILE even for its genuine operator', async () => {
  // Recovery refusal needs a real Room FILE, not an unrelated Room agent-session target.
  const h = await authorityFixture(true, false, false);
  cleanup.push(h.cleanup);
  cleanup.push(() => h.http.fileWrites.stop());
  await initBoundary(h.dir);
  expect(h.scope).toMatch(/^room:/);
  expect(h.http.authorization.requireCurrent(h.input.documentId, h.actor, true).scope).toBe(
    h.scope
  );
  expect(
    h.db.select().from(canvasDocuments).where(eq(canvasDocuments.id, h.input.documentId)).get()
  ).toMatchObject({
    id: h.input.documentId,
    scope: h.scope,
    roomId: h.scope.slice(5),
    contentType: 'markdown',
    content: { type: 'markdown', sourcePath: h.path },
    resolvedCwd: h.dir,
  });
  const birth = CanvasDocIncarnationSchema.parse(
    (await h.http.service.replay(h.input.documentId, h.actor)).incarnation
  );
  expect(birth.documentId).toBe(h.input.documentId);
  const originalFile = await fs.readFile(h.path, 'utf8');
  const originalChannel = h.http.channels.getChannel(h.input.documentId);
  const rename = vi.spyOn(fs, 'rename');
  const write = vi.spyOn(fs, 'writeFile');
  await expect(
    discoverOriginalDocumentFileSaves(h.http.fileWrites, h.input.documentId, { headers: {} })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  expect(rename).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(await fs.readFile(h.path, 'utf8')).toBe(originalFile);
  expect(h.db.select().from(canvasDocFileSaveIntents).all()).toEqual([]);
  expect(h.http.channels.getChannel(h.input.documentId)).toEqual(originalChannel);
});
it('refuses a committed intent with missing original event proof instead of synthesizing history', async () => {
  const f = await setup(),
    input = f.input();
  await f.save(input);
  f.h.db.run(
    sql`DELETE FROM canvas_doc_events WHERE document_id=${f.documentId} AND event_id=${input.documentSave.eventId}`
  );
  await request(server.server)
    .post(`${f.endpoint}/${input.documentSave.eventId}/recover`)
    .send({ expectedIncarnation: f.incarnation })
    .expect(503);
  expect(f.intent(input.documentSave.eventId).status).toBe('committed');
});
it('tracks an admitted proof read through stop/drain and rejects new discovery while it finishes', async () => {
  const f = await setup(),
    input = f.input();
  await f.save(input);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
    started = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.h.path && args[1] === 'r') {
      started();
      await held;
    }
    return handle;
  });
  const recovery = f.recover(input.documentSave.eventId);
  await entered;
  let stopped = false;
  const stop = f.h.http.fileWrites.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  await expect(f.discover()).rejects.toThrow();
  release();
  expect((await recovery).entry.state).toBe('receipt');
  await stop;
  expect(stopped).toBe(true);
});

it('refused close preserves current birth for discovery and proof-only recovery before successful close', async () => {
  const f = await setup(),
    input = f.input(),
    rename = vi.spyOn(fs, 'rename');
  f.fail();
  await expect(f.save(input)).rejects.toThrow();
  f.allow();
  const originalRenames = rename.mock.calls.filter(([, to]) => String(to) === f.h.path).length;
  expect(originalRenames).toBe(1);
  const close = () => f.h.rooms.canvas.close(f.h.scope, f.documentId);
  expect(close).toThrow(DocumentFileSaveCloseBlockedError);
  const found = await request(server.server).get(f.endpoint).expect(200);
  expect(FileSaveDiscoverySchema.parse(found.body).entries).toEqual([
    expect.objectContaining({ eventId: input.documentSave.eventId, state: 'review' }),
  ]);
  const recovered = await request(server.server)
    .post(`${f.endpoint}/${input.documentSave.eventId}/recover`)
    .send({ expectedIncarnation: f.incarnation })
    .expect(200);
  expect(FileSaveRecoverResultSchema.parse(recovered.body).entry).toMatchObject({
    state: 'receipt',
    receipt: { eventId: input.documentSave.eventId },
  });
  expect(rename.mock.calls.filter(([, to]) => String(to) === f.h.path)).toHaveLength(
    originalRenames
  );
  expect(f.batches()).toHaveLength(0);
  close();
  expect(f.h.rooms.canvasDocuments.lookupIdentity(f.documentId)).toBeUndefined();
});
