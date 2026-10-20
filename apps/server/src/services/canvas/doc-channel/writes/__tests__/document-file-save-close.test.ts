/** Real original file saves and SQLite lifecycle ordering; no timer-based race simulation. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, sql, sessionMetadata, canvasDocFileSaveIntents } from '@dorkos/db';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-channel-schemas';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import { createSessionCanvasRoutes } from '../../../../../routes/session-canvas.js';
import { initBoundary } from '../../../../../lib/boundary.js';
import { initConfigManager } from '../../../../core/config-manager.js';
import { setCanvasService, MAX_CANVAS_DOCUMENTS } from '../../../index.js';
import { setRoomService } from '../../../../rooms/index.js';
import { DocumentFileSaveCloseBlockedError } from '../file-save-lifecycle/close-guard.js';
import { saveOriginalDocumentFile } from '../installation-file-writes.js';
import { authorityFixture } from './authority-fixtures.js';
const cleanup: Array<() => Promise<void>> = [];
const server = swappableServer();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  cleanup.push(async () => release());
  return { enter, release, entered, held };
}
async function setup() {
  const h = await authorityFixture(false, false, true);
  cleanup.push(h.cleanup);
  cleanup.push(() => h.http.fileWrites.stop());
  await initBoundary(h.dir);
  initConfigManager(h.dir);
  const sessionId = randomUUID(),
    scope = `session:${sessionId}`;
  h.db
    .insert(sessionMetadata)
    .values({ sessionId, agentPath: h.dir, runtime: 'codex', createdAt: new Date().toISOString() })
    .run();
  const doc = h.rooms.canvas.open(
    scope,
    'owner',
    { type: 'file', title: 'Original file', sourcePath: h.path },
    { tree: { resolvedCwd: h.dir, treeKind: 'agent-cwd', sourceLabel: null, aheadOfMain: null } }
  );
  const incarnation = CanvasDocIncarnationSchema.parse(
      (await h.http.service.replay(doc.id, h.actor)).incarnation
    ),
    before = await fs.readFile(h.path, 'utf8');
  const input = (content = 'Changed original file') => ({
    cwd: h.dir,
    path: h.path,
    content,
    expectedContent: before,
    documentSave: { documentId: doc.id, eventId: randomUUID(), incarnation },
  });
  const save = (raw: ReturnType<typeof input>) =>
    saveOriginalDocumentFile(h.http.fileWrites, raw, { headers: {} });
  const close = () => h.rooms.canvas.close(scope, doc.id);
  const retained = () => h.rooms.canvasDocuments.lookupIdentity(doc.id);
  const intent = (eventId: string) =>
    h.db
      .select()
      .from(canvasDocFileSaveIntents)
      .where(eq(canvasDocFileSaveIntents.eventId, eventId))
      .get();
  const fail = () =>
    h.db.run(
      sql`CREATE TRIGGER refuse_close_receipt BEFORE INSERT ON canvas_doc_events WHEN NEW.type='doc.saved' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`
    );
  const allow = () => h.db.run(sql`DROP TRIGGER refuse_close_receipt`);
  setRoomService(h.rooms.service);
  setCanvasService(h.rooms.canvas);
  server.mount(
    honoGroupListener({ path: '/api/sessions/:id/canvas', routes: createSessionCanvasRoutes() })
  );
  return {
    h,
    doc,
    sessionId,
    scope,
    incarnation,
    before,
    input,
    save,
    close,
    retained,
    intent,
    fail,
    allow,
    endpoint: `/api/sessions/${sessionId}/canvas/${doc.id}`,
  };
}
it('close wins before preparation: original save refuses without intent, rename or event', async () => {
  const f = await setup(),
    b = barrier(),
    raw = f.input(),
    open = fs.open.bind(fs);
  let held = false;
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (!held && String(path) === f.h.path && flags === 'r') {
      held = true;
      b.enter();
      await b.held;
    }
    return handle;
  });
  const rename = vi.spyOn(fs, 'rename');
  const outcome = f.save(raw).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await b.entered;
  f.close();
  expect(f.retained()).toBeUndefined();
  expect(f.h.http.channels.getChannel(f.doc.id)?.closedAt).not.toBeNull();
  b.release();
  expect(await outcome).toHaveProperty('error');
  expect(f.intent(raw.documentSave.eventId)).toBeUndefined();
  expect(rename).not.toHaveBeenCalled();
  expect(f.h.http.channels.getEvent(f.doc.id, raw.documentSave.eventId)).toBeUndefined();
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(f.before);
});
it('a genuinely prepared save refuses close before any replacement and completes under its original birth', async () => {
  const f = await setup(),
    b = barrier(),
    raw = f.input(),
    open = fs.open.bind(fs);
  let held = false;
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (!held && flags === 'wx') {
      held = true;
      b.enter();
      await b.held;
    }
    return handle;
  });
  const saving = f.save(raw);
  await b.entered;
  expect(f.intent(raw.documentSave.eventId)?.status).toBe('prepared');
  expect(f.close).toThrow(DocumentFileSaveCloseBlockedError);
  expect(f.retained()).toBeDefined();
  expect(f.h.http.channels.getChannel(f.doc.id)?.closedAt).toBeNull();
  b.release();
  await saving;
  expect(f.intent(raw.documentSave.eventId)?.status).toBe('committed');
  f.close();
  expect(f.retained()).toBeUndefined();
});
it('a genuinely staged save refuses close while its original rename has not started', async () => {
  const f = await setup(),
    b = barrier(),
    raw = f.input(),
    rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    b.enter();
    await b.held;
    return rename(from, to);
  });
  const saving = f.save(raw);
  await b.entered;
  expect(f.intent(raw.documentSave.eventId)?.status).toBe('staged');
  expect(f.close).toThrow(DocumentFileSaveCloseBlockedError);
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(f.before);
  b.release();
  await saving;
  f.close();
  expect(f.retained()).toBeUndefined();
});
it('refuses actual HTTP close after rename before receipt, preserving original identity until completion', async () => {
  const f = await setup(),
    b = barrier(),
    raw = f.input(),
    rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    b.enter();
    await b.held;
  });
  const saving = f.save(raw);
  await b.entered;
  const physical = await fs.stat(f.h.path, { bigint: true });
  expect(await fs.readFile(f.h.path, 'utf8')).toBe(raw.content);
  const response = await request(server.server).delete(f.endpoint).expect(409);
  expect(response.body).toMatchObject({ code: 'DOC_SAVE_RECOVERY_REQUIRED' });
  expect(response.body.error).toContain('Keep it open');
  expect(f.retained()).toBeDefined();
  expect(f.h.http.channels.getChannel(f.doc.id)?.closedAt).toBeNull();
  b.release();
  await saving;
  expect(f.intent(raw.documentSave.eventId)?.status).toBe('committed');
  expect(f.h.http.channels.getEvent(f.doc.id, raw.documentSave.eventId)?.type).toBe('doc.saved');
  const after = await fs.stat(f.h.path, { bigint: true });
  expect([after.dev, after.ino]).toEqual([physical.dev, physical.ino]);
  await request(server.server).delete(f.endpoint).expect(204);
  expect(f.retained()).toBeUndefined();
});
it('receipt failure leaves in_doubt original live; exact retry settles once before close', async () => {
  const f = await setup(),
    raw = f.input();
  f.fail();
  await expect(f.save(raw)).rejects.toThrow('receipt unavailable');
  f.allow();
  const rename = vi.spyOn(fs, 'rename');
  expect(f.intent(raw.documentSave.eventId)?.status).toBe('in_doubt');
  expect(f.close).toThrow(DocumentFileSaveCloseBlockedError);
  await f.save(raw);
  expect(rename).not.toHaveBeenCalled();
  expect(f.intent(raw.documentSave.eventId)?.status).toBe('committed');
  f.close();
  expect(f.retained()).toBeUndefined();
});
it.each(['no_op', 'failed', 'committed'] as const)(
  'terminal %s evidence permits normal closure',
  async (status) => {
    const f = await setup(),
      raw = f.input(status === 'committed' ? 'changed' : f.before);
    await f.save(raw);
    if (status === 'failed')
      f.h.db
        .update(canvasDocFileSaveIntents)
        .set({ status: 'failed' })
        .where(eq(canvasDocFileSaveIntents.eventId, raw.documentSave.eventId))
        .run();
    expect(f.intent(raw.documentSave.eventId)?.status).toBe(status);
    f.close();
    expect(f.retained()).toBeUndefined();
  }
);
it('an unknown durable phase refuses deletion after explicit test-only CHECK bypass', async () => {
  const f = await setup(),
    raw = f.input(f.before);
  await f.save(raw);
  f.h.db.run(sql`PRAGMA ignore_check_constraints=ON`);
  try {
    f.h.db.run(
      sql`UPDATE canvas_doc_file_save_intents SET status='unrecognized' WHERE event_id=${raw.documentSave.eventId}`
    );
  } finally {
    f.h.db.run(sql`PRAGMA ignore_check_constraints=OFF`);
  }
  expect(f.close).toThrow();
  expect(f.retained()).toBeDefined();
  expect(f.h.http.channels.getChannel(f.doc.id)?.closedAt).toBeNull();
});
it('normal SQLite rejects NULL phase before storage and leaves terminal closure usable', async () => {
  const f = await setup(),
    raw = f.input(f.before);
  await f.save(raw);
  expect(() =>
    f.h.db.run(
      sql`UPDATE canvas_doc_file_save_intents SET status=NULL WHERE event_id=${raw.documentSave.eventId}`
    )
  ).toThrow();
  expect(f.intent(raw.documentSave.eventId)?.status).toBe('no_op');
  f.close();
  expect(f.retained()).toBeUndefined();
});
it('malformed unresolved evidence refuses closure and remains ineligible for eviction', async () => {
  const f = await setup(),
    raw = f.input(f.before);
  await f.save(raw);
  f.h.db
    .update(canvasDocFileSaveIntents)
    .set({ status: 'prepared', requestHash: 'not-a-hash' })
    .where(eq(canvasDocFileSaveIntents.eventId, raw.documentSave.eventId))
    .run();
  expect(f.close).toThrow();
  expect(f.retained()).toBeDefined();
  expect(
    f.h.rooms.canvasDocuments.evictionCandidates(f.scope).some((row) => row.id === f.doc.id)
  ).toBe(false);
});
it('LRU preserves an unresolved original while evicting other eligible documents', async () => {
  const f = await setup(),
    raw = f.input();
  f.fail();
  await expect(f.save(raw)).rejects.toThrow();
  f.allow();
  for (let i = 0; i < MAX_CANVAS_DOCUMENTS + 3; i++)
    f.h.rooms.canvas.open(f.scope, 'owner', { type: 'json', title: `eligible-${i}`, data: { i } });
  expect(f.retained()).toBeDefined();
  expect(f.h.rooms.canvas.list(f.scope)).toHaveLength(MAX_CANVAS_DOCUMENTS);
  expect(f.h.http.channels.getChannel(f.doc.id)?.closedAt).toBeNull();
});
it('bounds fresh LRU save-fence reads after skipping excluded and unresolved oldest rows', async () => {
  const f = await setup(),
    raw = f.input();
  f.fail();
  await expect(f.save(raw)).rejects.toThrow();
  f.allow();
  const eligible = Array.from({ length: 5 }, (_, i) =>
    f.h.rooms.canvas.open(f.scope, 'owner', { type: 'json', title: `bounded-${i}`, data: { i } })
  );
  const ordered = [f.doc, ...eligible];
  for (const [i, row] of ordered.entries())
    f.h.db.run(
      sql`UPDATE canvas_documents SET last_active_at=${new Date(i * 1000).toISOString()} WHERE id=${row.id}`
    );
  const prepare = vi.spyOn(f.h.db.$client, 'prepare');
  const selected = f.h.rooms.canvasDocuments.evictionCandidates(f.scope, {
    limit: 1,
    eligible: (row) => row.id !== eligible[0]!.id,
  });
  expect(selected.map((row) => row.id)).toEqual([eligible[1]!.id]);
  const fenceReads = prepare.mock.calls.filter(([query]) =>
    String(query).includes('from "canvas_doc_file_save_intents"')
  );
  // The unresolved oldest is checked, the excluded row is not, and the suffix is untouched.
  expect(fenceReads).toHaveLength(2);
  prepare.mockRestore();
  expect(f.retained()).toBeDefined();
  expect(f.h.rooms.canvasDocuments.evictionCandidates(f.scope).map((row) => row.id)).toEqual(
    eligible.map((row) => row.id)
  );
});
it('orphan sweep removes only eligible identities, retains mark and finishes after original settlement', async () => {
  const f = await setup(),
    raw = f.input();
  f.fail();
  await expect(f.save(raw)).rejects.toThrow();
  f.allow();
  const eligible = f.h.rooms.canvas.open(f.scope, 'owner', {
    type: 'json',
    title: 'eligible',
    data: { ok: true },
  });
  const otherScope = 'session:other-removed-session';
  const other = f.h.rooms.canvas.open(otherScope, 'owner', {
    type: 'json',
    title: 'other',
    data: { ok: true },
  });
  const removed: string[] = [];
  const unsubscribe = f.h.rooms.canvas.onRemoved((_scope, id) => removed.push(id));
  cleanup.push(async () => unsubscribe());
  f.h.rooms.canvas.noteSessionOrphaned(f.sessionId);
  f.h.rooms.canvas.noteSessionOrphaned('other-removed-session');
  expect(
    f.h.rooms.canvas.sweepOrphanedCanvasDocuments({ sessions: [], degradedRuntimes: [] })
  ).toBe(2);
  expect(f.retained()).toBeDefined();
  expect(f.h.rooms.canvasDocuments.lookupIdentity(eligible.id)).toBeUndefined();
  expect(f.h.rooms.canvasDocuments.lookupIdentity(other.id)).toBeUndefined();
  expect(removed).toEqual(expect.arrayContaining([eligible.id, other.id]));
  expect(removed).not.toContain(f.doc.id);
  expect(f.h.rooms.canvas.orphanMarkCount()).toBe(1);
  await f.save(raw);
  expect(
    f.h.rooms.canvas.sweepOrphanedCanvasDocuments({ sessions: [], degradedRuntimes: [] })
  ).toBe(1);
  expect(f.h.rooms.canvas.orphanMarkCount()).toBe(0);
  expect(removed.filter((id) => id === f.doc.id)).toHaveLength(1);
});
it('explicit whole-scope teardown rolls back all removals when an original is unresolved', async () => {
  const f = await setup(),
    raw = f.input();
  f.fail();
  await expect(f.save(raw)).rejects.toThrow();
  f.allow();
  const eligible = f.h.rooms.canvas.open(f.scope, 'owner', {
    type: 'json',
    title: 'eligible',
    data: { ok: true },
  });
  expect(() => f.h.rooms.canvasDocuments.removeScope(f.scope)).toThrow(
    DocumentFileSaveCloseBlockedError
  );
  expect(f.retained()).toBeDefined();
  expect(f.h.rooms.canvasDocuments.lookupIdentity(eligible.id)).toBeDefined();
  expect(f.h.http.channels.getChannel(eligible.id)?.closedAt).toBeNull();
});
