/**
 * A file opened in a chat with no agent (DOR-2665): its root is the folder the
 * server recorded when the document was opened, never a caller's path, and an
 * agent-bound chat keeps the agent-directory rule unchanged.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as preparedReaders from '../../readers/prepared-readers.js';
import * as fileRouteGuards from '../../../../../lib/file-route-guards.js';
import { eq, sql, canvasDocuments, sessionMetadata } from '@dorkos/db';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { FileDocumentSaveReceiptSchema } from '@dorkos/shared/schemas';
import { FileSaveDiscoverySchema } from '@dorkos/shared/file-save/recovery';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import {
  createCanvasDocEventRoutes,
  canvasDocBodyRule,
} from '../../../../../routes/canvas-doc-events.js';
import { createFileRoutes } from '../../../../../routes/files.js';
import { initBoundary } from '../../../../../lib/boundary.js';
import { controlUi } from '../../../../session/browser-seat/ui-control.js';
import { initConfigManager } from '../../../../core/config-manager.js';
import { setCanvasService } from '../../../index.js';
import { setRoomService } from '../../../../rooms/index.js';
import { DocChannelNotFoundError } from '../../authorization.js';
import { DocRouteGrantError } from '../../grant-policy.js';
import { readDocSourceDescriptor } from '../../doc-source-policy.js';
import { authorityFixture } from './authority-fixtures.js';
import {
  discoverOriginalDocumentFileSaves,
  saveOriginalDocumentFile,
} from '../installation-file-writes.js';

// Pass-through by default; a test flips one to inject a real fault at the exact
// place the save path decides between "not available" and a server fault.
const faults = vi.hoisted(() => ({ sessionRead: false, resolveFile: false }));
vi.mock('../../readers/prepared-readers.js', async (original) => {
  const actual = await original<typeof preparedReaders>();
  return {
    ...actual,
    readPreparedSourceSession: (...args: Parameters<typeof actual.readPreparedSourceSession>) => {
      if (faults.sessionRead) throw new Error('database disk image is malformed');
      return actual.readPreparedSourceSession(...args);
    },
  };
});
vi.mock('../../../../../lib/file-route-guards.js', async (original) => {
  const actual = await original<typeof fileRouteGuards>();
  return {
    ...actual,
    resolveWithinCwd: async (...args: Parameters<typeof actual.resolveWithinCwd>) => {
      if (faults.resolveFile) throw Object.assign(new Error('i/o error'), { code: 'EIO' });
      return actual.resolveWithinCwd(...args);
    },
  };
});

const docs = swappableServer();
const files = swappableServer();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  faults.sessionRead = false;
  faults.resolveFile = false;
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

const SESSION = 'session-a';

/** The real fixture, with its session's agent binding set to `agentPath`. */
async function setup(agentPath: string | null, boundary?: (dir: string) => string) {
  const h = await authorityFixture(false, false, true);
  cleanup.push(h.cleanup);
  cleanup.push(() => h.http.fileWrites.stop());
  await initBoundary(boundary ? boundary(h.dir) : h.dir);
  initConfigManager(h.dir);
  setRoomService(h.rooms.service);
  setCanvasService(h.rooms.canvas);
  bindSession(h, agentPath);
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
type Fixture = Awaited<ReturnType<typeof authorityFixture>>;

function bindSession(h: Fixture, agentPath: string | null) {
  h.db
    .update(sessionMetadata)
    .set({ agentPath })
    .where(eq(sessionMetadata.sessionId, SESSION))
    .run();
}

/** Open a file the way a chat turn does: through the session's own canvas writer and cwd. */
async function openInChat(h: Fixture, cwd: string, name = 'notes.md', fileDir = h.dir) {
  const path = join(fileDir, name);
  const content = 'original bytes';
  await fs.writeFile(path, content, { flag: 'wx' });
  const opened = await controlUi(
    { action: 'open_canvas', content: { type: 'file', title: 'Notes', sourcePath: path } },
    { sessionId: SESSION, cwd, principal: h.runtime.principal }
  );
  if (typeof opened.documentId !== 'string') throw new Error('File document missing');
  const documentId = opened.documentId;
  expect(
    h.db.select().from(canvasDocuments).where(eq(canvasDocuments.id, documentId)).get()
  ).toMatchObject({ resolvedCwd: cwd, treeKind: null });
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await h.http.service.replay(documentId, h.actor)).incarnation
  );
  const input = (next = 'edited in the canvas') => ({
    cwd,
    path,
    content: next,
    expectedContent: content,
    documentSave: { documentId, eventId: randomUUID(), incarnation },
  });
  const endpoint = `/api/canvas/docs/${encodeURIComponent(documentId)}/file-saves`;
  return { path, content, documentId, input, endpoint };
}

it('a chat with no agent discovers saves and saves its file with a receipt', async () => {
  const h = await setup(null);
  const doc = await openInChat(h, h.dir);

  const empty = await request(docs.server).get(doc.endpoint);
  expect(empty.status).toBe(200);
  expect(FileSaveDiscoverySchema.parse(empty.body)).toMatchObject({
    documentId: doc.documentId,
    admission: 'not_observed_blocked',
    entries: [],
  });

  const input = doc.input();
  const saved = await request(files.server).put('/api/files/content').send(input);
  expect(saved.status).toBe(200);
  expect(FileDocumentSaveReceiptSchema.parse(saved.body.documentReceipt)).toMatchObject({
    documentId: doc.documentId,
    eventId: input.documentSave.eventId,
    status: 'accepted',
  });
  expect(await fs.readFile(doc.path, 'utf8')).toBe(input.content);

  const found = await discoverOriginalDocumentFileSaves(h.http.fileWrites, doc.documentId, {
    headers: {},
  });
  expect(found.entries).toEqual([
    expect.objectContaining({ eventId: input.documentSave.eventId, state: 'receipt' }),
  ]);
});

it('a chat with no agent still refuses an agent caller', async () => {
  const h = await setup(null);
  const doc = await openInChat(h, h.dir);
  const input = doc.input();
  await expect(
    saveOriginalDocumentFile(h.http.fileWrites, input, {
      headers: { 'x-dorkos-agent': 'presented' },
    })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  await expect(
    discoverOriginalDocumentFileSaves(h.http.fileWrites, doc.documentId, {
      headers: { 'x-dorkos-agent': 'presented' },
    })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
});

it('a chat with no agent cannot save a file outside the folder it recorded', async () => {
  // The boundary is wider than the recorded folder, so only the folder refuses.
  const h = await setup(null, (dir) => dirname(dir));
  const recorded = join(h.dir, 'recorded');
  await fs.mkdir(recorded);
  const doc = await openInChat(h, recorded);
  const input = doc.input();
  await expect(
    saveOriginalDocumentFile(h.http.fileWrites, { ...input, cwd: h.dir }, { headers: {} })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  await request(docs.server).get(doc.endpoint).expect(404);
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
});

it('a document with no recorded folder answers 404, not a server fault, on both routes', async () => {
  const h = await setup(null);
  const path = join(h.dir, 'opened-by-a-person.md');
  await fs.writeFile(path, 'unchanged', { flag: 'wx' });
  const doc = h.rooms.canvas.open(`session:${SESSION}`, 'owner', {
    type: 'file',
    title: 'No folder on record',
    sourcePath: path,
  });
  const incarnation = CanvasDocIncarnationSchema.parse(
    (await h.http.service.replay(doc.id, h.actor)).incarnation
  );
  const discovery = await request(docs.server).get(
    `/api/canvas/docs/${encodeURIComponent(doc.id)}/file-saves`
  );
  expect(discovery.status).toBe(404);
  expect(discovery.body.code).toBe('DOC_FILE_SAVE_UNAVAILABLE');
  const saved = await request(files.server)
    .put('/api/files/content')
    .send({
      cwd: h.dir,
      path,
      content: 'must not write',
      expectedContent: 'unchanged',
      documentSave: { documentId: doc.id, eventId: randomUUID(), incarnation },
    });
  expect(saved.status).toBe(404);
  expect(saved.body.code).toBe('CANVAS_DOCUMENT_NOT_FOUND');
  expect(await fs.readFile(path, 'utf8')).toBe('unchanged');
});

it('a real fault while reading save evidence still answers 503', async () => {
  const h = await setup(null);
  const doc = await openInChat(h, h.dir);
  const input = doc.input(doc.content);
  await saveOriginalDocumentFile(h.http.fileWrites, input, { headers: {} });
  h.db.run(sql`PRAGMA ignore_check_constraints=ON`);
  try {
    h.db.run(
      sql`UPDATE canvas_doc_file_save_intents SET status='unrecognized' WHERE event_id=${input.documentSave.eventId}`
    );
  } finally {
    h.db.run(sql`PRAGMA ignore_check_constraints=OFF`);
  }
  await request(docs.server).get(doc.endpoint).expect(503);
});

it('binding the chat to an agent elsewhere moves the root and refuses the old folder', async () => {
  const h = await setup(null);
  const doc = await openInChat(h, h.dir);
  await request(docs.server).get(doc.endpoint).expect(200);
  const elsewhere = join(h.dir, 'agent-home');
  await fs.mkdir(elsewhere);
  bindSession(h, elsewhere);
  await request(docs.server).get(doc.endpoint).expect(404);
  const input = doc.input();
  await expect(
    saveOriginalDocumentFile(h.http.fileWrites, input, { headers: {} })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
});

it('an agent-bound chat keeps its rule: a recorded folder other than the agent directory is refused', async () => {
  const h = await setup(null);
  const recorded = join(h.dir, 'inside-the-agent');
  await fs.mkdir(recorded);
  bindSession(h, h.dir);
  // The file sits inside both folders and the boundary; only the agent rule refuses it.
  const doc = await openInChat(h, recorded, 'notes.md', recorded);
  await request(docs.server).get(doc.endpoint).expect(404);
  await expect(
    saveOriginalDocumentFile(h.http.fileWrites, doc.input(), { headers: {} })
  ).rejects.toBeInstanceOf(DocChannelNotFoundError);
  expect(await fs.readFile(doc.path, 'utf8')).toBe(doc.content);
  // With the folder equal to the agent directory, the same chat saves as before.
  const same = await openInChat(h, h.dir, 'agent-notes.md');
  await request(docs.server).get(same.endpoint).expect(200);
});

it('route grants and checkbox writes keep the agent-only rule for a chat with no agent', async () => {
  const h = await setup(null);
  const doc = await openInChat(h, h.dir);
  // The save path admits it…
  await request(docs.server).get(doc.endpoint).expect(200);
  // …but the general reader route grants and checkbox writes use still refuses it.
  expect(() =>
    readDocSourceDescriptor(
      { db: h.db, documents: h.rooms.canvasDocuments, roomRepos: h.roomRepos },
      doc.documentId
    )
  ).toThrow(expect.objectContaining({ code: 'LOCAL_SOURCE_UNAVAILABLE' }));
  expect(() =>
    readDocSourceDescriptor(
      { db: h.db, documents: h.rooms.canvasDocuments, roomRepos: h.roomRepos },
      doc.documentId
    )
  ).toThrow(DocRouteGrantError);
});

it('a fault reading the session stays a server fault, not "not available"', async () => {
  const h = await setup(null);
  const doc = await openInChat(h, h.dir);
  faults.sessionRead = true;
  await request(docs.server).get(doc.endpoint).expect(503);
});

it('a fault resolving the file stays a server fault, not "not available"', async () => {
  const h = await setup(null);
  const doc = await openInChat(h, h.dir);
  faults.resolveFile = true;
  await request(docs.server).get(doc.endpoint).expect(503);
});

it('a recorded folder that no longer exists answers 404, not a fault worth retrying', async () => {
  const h = await setup(null);
  const recorded = join(h.dir, 'gone-later');
  await fs.mkdir(recorded);
  const doc = await openInChat(h, recorded, 'notes.md', recorded);
  await request(docs.server).get(doc.endpoint).expect(200);
  await fs.rm(recorded, { recursive: true });
  await request(docs.server).get(doc.endpoint).expect(404);
});
