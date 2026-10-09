import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  canvasDocuments,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocBatches,
  eq,
} from '@dorkos/db';
import { authorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { docDocumentGeneration } from '../identity/incarnation.js';
import { askServiceOriginalDocSelection, submitCurrentDocEvent } from '../service.js';

async function originalSelection(agentRoute = false) {
  const h = await authorityFixture(false, false, agentRoute, 'md.*');
  try {
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
    const bytes = await fs.readFile(h.path);
    const request = {
      documentId: h.input.documentId,
      expectedGeneration: docDocumentGeneration(physical, channel),
      eventId: randomUUID(),
      expectedFileHash: createHash('sha256').update(bytes).digest('hex'),
      sourceGeneration: 'original-editor-generation',
      ranges: [
        { start: 6, end: 12 },
        { start: 13, end: 17 },
      ],
      selectedText: 'actualtask',
    };
    return { h, request, bytes };
  } catch (cause) {
    try {
      await h.cleanup();
    } catch {}
    throw cause;
  }
}

describe('original authenticated host selection', () => {
  it('derives the exact raw ranges from the real file and retains one original event', async () => {
    const { h, request, bytes } = await originalSelection();
    try {
      const first = await askServiceOriginalDocSelection(h.http.service, request, h.actor);
      expect(first.receipt).toMatchObject({ id: request.eventId, status: 'recorded' });
      const row = h.db
        .select()
        .from(canvasDocEvents)
        .where(eq(canvasDocEvents.eventId, request.eventId))
        .get()!;
      expect(row.type).toBe('selection.ask');
      expect(row.payload).toEqual({
        sourceGeneration: request.sourceGeneration,
        fileHash: request.expectedFileHash,
        ranges: request.ranges,
        selectedText: 'actualtask',
      });
      expect(
        (await askServiceOriginalDocSelection(h.http.service, request, h.actor)).receipt
      ).toMatchObject({
        id: request.eventId,
        status: 'duplicate',
        docSeq: first.receipt.docSeq,
      });
      expect((await fs.readFile(h.path)).equals(bytes)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
  it('captures genuine approved selection routes before admission and preserves the original grant fence', async () => {
    const { h, request } = await originalSelection(true);
    try {
      h.http.grants.configure(
        request.documentId,
        {
          routes: [
            {
              id: 'selection',
              on: 'selection.ask',
              to: 'agent:owner',
              turn: { mode: 'immediate', maxBatch: 1 },
            },
          ],
        },
        h.actor,
        'a'
      );
      const grantRequest = {
        documentId: request.documentId,
        routeId: 'selection',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const pending = h.http.grants.grant(grantRequest, h.actor);
      expect(pending.kind).toBe('approval_required');
      if (pending.kind !== 'approval_required')
        throw new Error('Original selection approval missing');
      h.approvals.grant(pending.ticket.approvalId);
      const approved = h.http.grants.grant(grantRequest, h.actor, pending.ticket.token);
      expect(approved.kind).toBe('granted');
      if (approved.kind !== 'granted') throw new Error('Original selection grant missing');
      // Configuration changes the real declaration incarnation, not the file snapshot.
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, request.documentId))
        .get()!;
      const channel = h.db
        .select()
        .from(canvasDocChannels)
        .where(eq(canvasDocChannels.documentId, request.documentId))
        .get()!;
      request.expectedGeneration = docDocumentGeneration(physical, channel);
      h.http.grants.getCurrentRoutes = () => {
        throw new Error('Reflected selection routes used');
      };
      const accepted = await askServiceOriginalDocSelection(h.http.service, request, h.actor);
      expect(accepted.receipt).toMatchObject({ id: request.eventId, status: 'recorded' });
      expect(accepted.deliveries).toHaveLength(1);
      expect(accepted.deliveries[0]).toMatchObject({ routeId: 'selection' });
      const batches = h.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.documentId, request.documentId))
        .all();
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({
        routeId: 'selection',
        grantId: approved.grant.grantId,
        status: 'pending',
        inputEventIds: [request.eventId],
      });
    } finally {
      await h.cleanup();
    }
  });
  it('refuses rendered-text substitution, an external file change, and ordinary page impersonation', async () => {
    const { h, request } = await originalSelection();
    try {
      await expect(
        askServiceOriginalDocSelection(
          h.http.service,
          { ...request, selectedText: 'forged page text' },
          h.actor
        )
      ).rejects.toThrow();
      await expect(
        submitCurrentDocEvent(
          h.http.service,
          request.documentId,
          {
            v: 1,
            id: request.eventId,
            type: 'selection.ask',
            payload: { selectedText: request.selectedText },
          },
          h.actor,
          { expectedGeneration: request.expectedGeneration }
        )
      ).rejects.toThrow();
      await fs.appendFile(h.path, 'external edit');
      await expect(
        askServiceOriginalDocSelection(h.http.service, request, h.actor)
      ).rejects.toThrow();
      expect(
        h.db
          .select()
          .from(canvasDocEvents)
          .where(eq(canvasDocEvents.eventId, request.eventId))
          .get()
      ).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });
});
