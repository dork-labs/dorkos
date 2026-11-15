/**
 * A file the PERSON opens on their session's canvas (DOR-4442): the open route
 * records the session's agent folder server-side, so the file saves, and the
 * folder rule still refuses anything outside it. Never a folder from the body.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { agents, eq, canvasDocuments, sessionMetadata } from '@dorkos/db';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { FileDocumentSaveReceiptSchema } from '@dorkos/shared/schemas';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import {
  createCanvasDocEventRoutes,
  canvasDocBodyRule,
} from '../../../../../routes/canvas-doc-events.js';
import { createFileRoutes } from '../../../../../routes/files.js';
import { createSessionCanvasRoutes } from '../../../../../routes/session-canvas.js';
import { initBoundary } from '../../../../../lib/boundary.js';
import { initConfigManager } from '../../../../core/config-manager.js';
import { runtimeRegistry } from '../../../../core/runtime-registry.js';
import { setCanvasService } from '../../../index.js';
import { setRoomService } from '../../../../rooms/index.js';
import { DocChannelNotFoundError } from '../../authorization.js';
import { authorityFixture } from './authority-fixtures.js';
import { saveOriginalDocumentFile } from '../installation-file-writes.js';

const canvasRoutes = swappableServer();
const docs = swappableServer();
const files = swappableServer();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

// The session routes take a real session id, unlike the fixture's own `session-a`.
const SESSION = randomUUID();
type Fixture = Awaited<ReturnType<typeof authorityFixture>>;

/** The real fixture, its session bound to `agentPath`, with the three routes a save crosses. */
async function setup(
  agentPath: (dir: string) => string | null,
  boundary?: (dir: string) => string
) {
  const h = await authorityFixture(false, false, true);
  cleanup.push(h.cleanup);
  cleanup.push(() => h.http.fileWrites.stop());
  await initBoundary(boundary ? boundary(h.dir) : h.dir);
  initConfigManager(h.dir);
  runtimeRegistry.setDb(h.db);
  setRoomService(h.rooms.service);
  setCanvasService(h.rooms.canvas);
  h.db
    .insert(sessionMetadata)
    .values({
      sessionId: SESSION,
      agentPath: agentPath(h.dir),
      runtime: 'codex',
      createdAt: new Date().toISOString(),
    })
    .run();
  canvasRoutes.mount(
    honoGroupListener({ path: '/api/sessions/:id/canvas', routes: createSessionCanvasRoutes() })
  );
  docs.mount(
    honoGroupListener(
      { path: '/api/canvas/docs', routes: createCanvasDocEventRoutes(() => h.http) },
      { bodyRules: [canvasDocBodyRule(() => undefined)] }
    )
  );
  files.mount(
    honoGroupListener({ path: '/api/files', routes: createFileRoutes(h.http.fileWrites) })
  );
  return h;
}

/** Open a file the way the person's window does: POST to the session's canvas route. */
async function openAsPerson(h: Fixture, path: string, extra: Record<string, unknown> = {}) {
  const content = 'original bytes';
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, { flag: 'wx' });
  const opened = await request(canvasRoutes.server)
    .post(`/api/sessions/${SESSION}/canvas`)
    .send({ content: { type: 'file', title: 'Notes', sourcePath: path }, ...extra });
  expect(opened.status).toBe(201);
  const documentId = opened.body.id as string;
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await h.http.service.replay(documentId, h.actor)).incarnation
  );
  const input = (cwd: string, next = 'edited in the canvas') => ({
    cwd,
    path,
    content: next,
    expectedContent: content,
    documentSave: { documentId, eventId: randomUUID(), incarnation },
  });
  const row = () =>
    h.db.select().from(canvasDocuments).where(eq(canvasDocuments.id, documentId)).get();
  const endpoint = `/api/canvas/docs/${encodeURIComponent(documentId)}/file-saves`;
  return { path, content, documentId, input, row, endpoint };
}

it('a file the person opens inside the agent folder records that folder and saves', async () => {
  const h = await setup((dir) => dir);
  const doc = await openAsPerson(h, join(h.dir, 'notes.md'));
  expect(doc.row()).toMatchObject({ resolvedCwd: h.dir, treeKind: null });

  await request(docs.server).get(doc.endpoint).expect(200);
  const input = doc.input(h.dir);
  const saved = await request(files.server).put('/api/files/content').send(input);
  expect(saved.status).toBe(200);
  expect(FileDocumentSaveReceiptSchema.parse(saved.body.documentReceipt)).toMatchObject({
    documentId: doc.documentId,
    status: 'accepted',
  });
  expect(await fs.readFile(doc.path, 'utf8')).toBe(input.content);
});

it('the folder comes from the session, never from the request body', async () => {
  const h = await setup((dir) => dir);
  const elsewhere = await fs.realpath(await fs.mkdtemp(join(dirname(h.dir), 'not-the-agent-')));
  cleanup.push(() => fs.rm(elsewhere, { recursive: true, force: true }));
  const doc = await openAsPerson(h, join(h.dir, 'notes.md'), {
    resolvedCwd: elsewhere,
    cwd: elsewhere,
    tree: { resolvedCwd: elsewhere, treeKind: 'agent-cwd' },
  });
  expect(doc.row()?.resolvedCwd).toBe(h.dir);
});

it('a file the person opens outside the agent folder, inside the boundary, is still refused', async () => {
  // The boundary is wider than the agent folder, so only the folder rule refuses.
  const h = await setup(
    (dir) => join(dir, 'agent'),
    (dir) => dir
  );
  await fs.mkdir(join(h.dir, 'agent'));
  const doc = await openAsPerson(h, join(h.dir, 'outside', 'notes.md'));
  expect(doc.row()?.resolvedCwd).toBe(join(h.dir, 'agent'));
  await request(docs.server).get(doc.endpoint).expect(404);
  // A caller cwd that the file route itself admits: only the recorded folder refuses.
  await expect(
    saveOriginalDocumentFile(h.http.fileWrites, doc.input(h.dir), { headers: {} })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
});

it('a file the person opens in another agent’s folder is still refused', async () => {
  const h = await setup(
    (dir) => join(dir, 'agent'),
    (dir) => dir
  );
  await fs.mkdir(join(h.dir, 'agent'));
  const other = join(h.dir, 'other-agent');
  await fs.mkdir(other);
  const at = new Date().toISOString();
  h.db
    .insert(agents)
    .values({
      id: 'b',
      name: 'Other agent',
      projectPath: other,
      runtime: 'codex',
      status: 'active',
      registeredAt: at,
      updatedAt: at,
    })
    .run();
  const doc = await openAsPerson(h, join(other, 'notes.md'));
  expect(doc.row()?.resolvedCwd).toBe(join(h.dir, 'agent'));
  await request(docs.server).get(doc.endpoint).expect(404);
  for (const cwd of [other, h.dir])
    await expect(
      saveOriginalDocumentFile(h.http.fileWrites, doc.input(cwd), { headers: {} })
    ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
});

it('a file the person opens outside the boundary is still refused', async () => {
  const h = await setup((dir) => join(dir, 'agent'));
  await fs.mkdir(join(h.dir, 'agent'));
  const outside = await fs.realpath(await fs.mkdtemp(join(dirname(h.dir), 'past-the-boundary-')));
  cleanup.push(() => fs.rm(outside, { recursive: true, force: true }));
  const doc = await openAsPerson(h, join(outside, 'notes.md'));
  await request(docs.server).get(doc.endpoint).expect(404);
  for (const cwd of [join(h.dir, 'agent'), outside])
    await expect(
      saveOriginalDocumentFile(h.http.fileWrites, doc.input(cwd), { headers: {} })
    ).rejects.toThrow();
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
});

it('a chat with no agent records no folder, and its save stays unavailable', async () => {
  const h = await setup(() => null);
  const doc = await openAsPerson(h, join(h.dir, 'notes.md'));
  expect(doc.row()?.resolvedCwd).toBeNull();
  const discovery = await request(docs.server).get(doc.endpoint);
  expect(discovery.status).toBe(404);
  expect(discovery.body.code).toBe('DOC_FILE_SAVE_UNAVAILABLE');
  await expect(
    saveOriginalDocumentFile(h.http.fileWrites, doc.input(h.dir), { headers: {} })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
});

it('a document opened before the fix, with no folder, gets it when the person reopens the file', async () => {
  const h = await setup((dir) => dir);
  const path = join(h.dir, 'opened-earlier.md');
  await fs.writeFile(path, 'unchanged', { flag: 'wx' });
  const earlier = h.rooms.canvas.open(`session:${SESSION}`, 'owner', {
    type: 'file',
    title: 'Notes',
    sourcePath: path,
  });
  const endpoint = `/api/canvas/docs/${encodeURIComponent(earlier.id)}/file-saves`;
  await request(docs.server).get(endpoint).expect(404);
  const reopened = await request(canvasRoutes.server)
    .post(`/api/sessions/${SESSION}/canvas`)
    .send({ content: { type: 'file', title: 'Notes', sourcePath: path } });
  expect(reopened.status).toBe(201);
  expect(reopened.body.id).toBe(earlier.id);
  expect(
    h.db.select().from(canvasDocuments).where(eq(canvasDocuments.id, earlier.id)).get()
  ).toMatchObject({ resolvedCwd: h.dir });
  await request(docs.server).get(endpoint).expect(200);
});
