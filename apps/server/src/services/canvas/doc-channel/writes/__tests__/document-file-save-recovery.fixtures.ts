/**
 * Shared setup for the document-file-save-recovery suites: everything the original file declared or
 * registered outside its tests.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import { eq, sql, canvasDocFileSaveIntents, canvasDocBatches } from '@dorkos/db';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import {
  createCanvasDocEventRoutes,
  canvasDocBodyRule,
} from '../../../../../routes/canvas-doc-events.js';
import { initBoundary } from '../../../../../lib/boundary.js';
import { initConfigManager } from '../../../../core/config-manager.js';
import { setCanvasService } from '../../../index.js';
import { setRoomService } from '../../../../rooms/index.js';
import { authorityFixture } from './authority-fixtures.js';
import {
  saveOriginalDocumentFile,
  discoverOriginalDocumentFileSaves,
  recoverOriginalDocumentFileSave,
} from '../installation-file-writes.js';

export const server = swappableServer();

export const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

export async function setup() {
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
