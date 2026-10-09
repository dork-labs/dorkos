import express from 'express';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  canvasDocuments,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocBatches,
  eq,
} from '@dorkos/db';
import {
  PageEventSchema,
  CanvasChannelDownstreamEventTypeSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import files from '../../../../../routes/files.js';
import { setRoomService, clearRoomService } from '../../../../rooms/index.js';
import { docDocumentGeneration } from '../../identity/incarnation.js';
import { authorityFixture } from './authority-fixtures.js';
const target = swappableServer();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function ownedSave(agentRoute = false) {
  const h = await authorityFixture(false, false, agentRoute, 'md.*');
  try {
    setRoomService(h.rooms.service);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.locals.docChannelHttp = h.http;
    app.use('/files', files);
    const server = target.mount(app);
    const original = await fs.readFile(h.path, 'utf8');
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, h.input.documentId))
      .get()!;
    const channel = h.db
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, h.input.documentId))
      .get()!;
    const identity = {
      documentId: h.input.documentId,
      expectedGeneration: docDocumentGeneration(physical, channel),
      eventId: randomUUID(),
      expectedFileHash: hash(original),
    };
    return {
      h,
      server,
      original,
      identity,
      async close() {
        try {
          await h.cleanup();
        } finally {
          clearRoomService(h.rooms.service);
        }
      },
    };
  } catch (cause) {
    try {
      await h.cleanup();
    } catch {}
    clearRoomService(h.rooms.service);
    throw cause;
  }
}

// Actual native file writer/SQLite and ordinary HTTP operator; no success DTO or private scope is fabricated.
describe('original document-bound normal save', () => {
  it('captures the genuinely approved doc.saved owner route and queues only the successful original changed save', async () => {
    const { h, server, original, identity, close } = await ownedSave(true);
    try {
      h.http.grants.configure(
        identity.documentId,
        {
          routes: [
            {
              id: 'saved',
              on: 'doc.saved',
              to: 'agent:owner',
              turn: { mode: 'immediate', maxBatch: 1 },
            },
          ],
        },
        h.actor,
        'a'
      );
      const grantRequest = {
        documentId: identity.documentId,
        routeId: 'saved',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const ticket = h.http.grants.grant(grantRequest, h.actor);
      expect(ticket.kind).toBe('approval_required');
      if (ticket.kind !== 'approval_required')
        throw new Error('Original save route approval missing');
      h.approvals.grant(ticket.ticket.approvalId);
      const approved = h.http.grants.grant(grantRequest, h.actor, ticket.ticket.token);
      expect(approved.kind).toBe('granted');
      if (approved.kind !== 'granted') throw new Error('Original save route grant missing');
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, identity.documentId))
        .get()!;
      const channel = h.db
        .select()
        .from(canvasDocChannels)
        .where(eq(canvasDocChannels.documentId, identity.documentId))
        .get()!;
      identity.expectedGeneration = docDocumentGeneration(physical, channel);
      h.http.grants.getCurrentRoutes = () => {
        throw new Error('Reflected save routes used');
      };
      const body = {
        cwd: h.dir,
        path: 'tasks.md',
        content: original + 'real saved owner input\n',
        expectedHash: hash(original),
        documentSave: identity,
      };
      const changed = await request(server).put('/files/content').send(body);
      expect(changed.status).toBe(200);
      expect(changed.body.documentReceipt.receipt).toMatchObject({
        id: identity.eventId,
        status: 'recorded',
      });
      expect(changed.body.documentReceipt.deliveries).toHaveLength(1);
      expect(changed.body.documentReceipt.deliveries[0]).toMatchObject({ routeId: 'saved' });
      const batch = h.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.documentId, identity.documentId))
        .all();
      expect(batch).toHaveLength(1);
      expect(batch[0]).toMatchObject({
        routeId: 'saved',
        grantId: approved.grant.grantId,
        status: 'pending',
        inputEventIds: [identity.eventId],
      });
      const duplicate = await request(server).put('/files/content').send(body);
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.documentReceipt.receipt).toMatchObject({
        id: identity.eventId,
        status: 'duplicate',
      });
      expect(
        h.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, identity.documentId))
          .all()
      ).toEqual(batch);
      const noOp = await request(server)
        .put('/files/content')
        .send({
          ...body,
          expectedHash: hash(body.content),
          documentSave: {
            ...identity,
            eventId: randomUUID(),
            expectedFileHash: hash(body.content),
          },
        });
      expect(noOp.status).toBe(200);
      expect(noOp.body.effect).toBe('no_op');
      expect(noOp.body.documentReceipt).toBeUndefined();
      expect(
        h.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, identity.documentId))
          .all()
      ).toEqual(batch);
    } finally {
      await close();
    }
  });

  it('emits only after changed persistence, recovers the same discarded-response ID, and emits nothing for no-op/conflict', async () => {
    const { h, server, original, identity, close } = await ownedSave();
    try {
      h.http.normalFileSave.saveHttp = () => {
        throw new Error('Reflected save used');
      };
      const content = original + 'confirmed native full save\n';
      const body = {
        cwd: h.dir,
        path: 'tasks.md',
        content,
        expectedHash: hash(original),
        documentSave: identity,
      };
      const first = await request(server).put('/files/content').send(body);
      expect(first.status).toBe(200);
      expect(first.body.effect).toBe('changed');
      expect(first.body.documentReceipt.receipt).toMatchObject({
        id: identity.eventId,
        status: 'recorded',
      });
      expect(await fs.readFile(h.path, 'utf8')).toBe(content);
      const event = h.db
        .select()
        .from(canvasDocEvents)
        .where(eq(canvasDocEvents.eventId, identity.eventId))
        .get()!;
      expect(event).toMatchObject({
        type: 'doc.saved',
        direction: 'upstream',
        payload: { previousFileHash: hash(original), fileHash: hash(content) },
      });
      // Discard the first response's disposition: repeat ONLY the retained original request.
      const duplicate = await request(server).put('/files/content').send(body);
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.effect).toBe('no_op');
      expect(duplicate.body.documentReceipt.receipt).toMatchObject({
        id: identity.eventId,
        status: 'duplicate',
        docSeq: event.docSeq,
      });
      expect(
        h.db
          .select()
          .from(canvasDocEvents)
          .where(eq(canvasDocEvents.documentId, identity.documentId))
          .all()
      ).toHaveLength(1);
      const noOpId = randomUUID();
      const noOp = await request(server)
        .put('/files/content')
        .send({
          ...body,
          expectedHash: hash(content),
          documentSave: { ...identity, eventId: noOpId, expectedFileHash: hash(content) },
        });
      expect(noOp.status).toBe(200);
      expect(noOp.body.effect).toBe('no_op');
      expect(noOp.body.documentReceipt).toBeUndefined();
      expect(
        h.db.select().from(canvasDocEvents).where(eq(canvasDocEvents.eventId, noOpId)).get()
      ).toBeUndefined();
      const conflictId = randomUUID();
      const conflict = await request(server)
        .put('/files/content')
        .send({
          ...body,
          content: content + 'new draft',
          documentSave: { ...identity, eventId: conflictId },
        });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('CONFLICT');
      expect(await fs.readFile(h.path, 'utf8')).toBe(content);
      expect(
        h.db.select().from(canvasDocEvents).where(eq(canvasDocEvents.eventId, conflictId)).get()
      ).toBeUndefined();
      const altered = await request(server)
        .put('/files/content')
        .send({ ...body, content: content + 'changed retry' });
      expect(altered.status).toBe(409);
      expect(await fs.readFile(h.path, 'utf8')).toBe(content);
    } finally {
      await close();
    }
  });
  it('refuses foreign file/generation and does not advertise a saved event when the actual native INSERT fails', async () => {
    const { h, server, original, identity, close } = await ownedSave();
    try {
      const content = original + 'persisted but event transaction refused\n';
      const body = {
        cwd: h.dir,
        path: 'tasks.md',
        content,
        expectedHash: hash(original),
        documentSave: identity,
      };
      const foreign = h.path + '.other';
      await fs.writeFile(foreign, original);
      const wrongFile = await request(server)
        .put('/files/content')
        .send({ ...body, path: foreign });
      expect(wrongFile.status).toBe(500);
      expect(await fs.readFile(foreign, 'utf8')).toBe(original);
      const wrongGeneration = await request(server)
        .put('/files/content')
        .send({ ...body, documentSave: { ...identity, expectedGeneration: '0'.repeat(64) } });
      expect(wrongGeneration.status).toBe(500);
      expect(await fs.readFile(h.path, 'utf8')).toBe(original);
      h.db.$client.exec(
        "CREATE TEMP TRIGGER reject_original_doc_saved BEFORE INSERT ON canvas_doc_events WHEN NEW.type='doc.saved' BEGIN SELECT RAISE(ABORT,'actual original save event refused'); END"
      );
      try {
        const failed = await request(server).put('/files/content').send(body);
        expect(failed.status).toBe(500);
        // A file effect with failed completion remains unknown; never manufacture a receipt or repeat the effect.
        expect(await fs.readFile(h.path, 'utf8')).toBe(content);
        expect(
          h.db
            .select()
            .from(canvasDocEvents)
            .where(eq(canvasDocEvents.eventId, identity.eventId))
            .get()
        ).toBeUndefined();
      } finally {
        h.db.$client.exec('DROP TRIGGER reject_original_doc_saved');
      }
      const retry = await request(server).put('/files/content').send(body);
      expect(retry.status).toBe(409);
      expect(await fs.readFile(h.path, 'utf8')).toBe(content);
      expect(
        h.db
          .select()
          .from(canvasDocEvents)
          .where(eq(canvasDocEvents.eventId, identity.eventId))
          .get()
      ).toBeUndefined();
    } finally {
      await close();
    }
  });
  it('keeps doc.saved unavailable to page and agent emitters', () => {
    expect(
      PageEventSchema.safeParse({
        v: 1,
        id: randomUUID(),
        type: 'doc.saved',
        payload: { fileHash: 'forged' },
      }).success
    ).toBe(false);
    expect(CanvasChannelDownstreamEventTypeSchema.safeParse('doc.saved').success).toBe(false);
  });
});
