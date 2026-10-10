/** Genuine FILE constructor/approval context; native SDK assembly controls live in their confined runtime suites. */
import { readServiceOriginalDocManagement } from '../service.js';
import { describe, expect, it, vi } from 'vitest';
import {
  approvals,
  canvasDocGrants,
  canvasDocWriteIntents,
  eq,
  createDb,
  runMigrations,
} from '@dorkos/db';
import { join } from 'node:path';
import {
  ConnectorRuntimePrincipalService,
  requireNativePrincipalDatabase,
  captureNativePrincipalTime,
  readCurrentNativePrincipal,
} from '../../../connectors/principal/runtime-principal-service.js';
import { authorityFixture } from '../writes/__tests__/authority-fixtures.js';

it('attests only the original migrated FILE connection while preserving genuine consumed approval', async () => {
  const h = await authorityFixture();
  let foreign: ReturnType<typeof createDb> | undefined;
  let failed = false,
    first: unknown;
  try {
    foreign = createDb(join(h.dir, 'foreign.sqlite'));
    const actualForeign = foreign;
    runMigrations(actualForeign);
    const native = new ConnectorRuntimePrincipalService({
      db: h.db,
      authority: {
        authorizeTurn: async () => {
          throw new Error('No native runtime supplied');
        },
        revalidateTurn: async () => false,
      },
    });
    requireNativePrincipalDatabase(native, h.db);
    expect(() => requireNativePrincipalDatabase(native, actualForeign)).toThrow(
      'exact owning database'
    );
    const original = await h.authority.prepare(h.input, h.actor);
    expect(original.documentId).toBe(h.input.documentId);
    expect(
      h.db.select().from(approvals).where(eq(approvals.id, h.granted.grant.approvalId!)).get()
        ?.consumedAt
    ).toBeTruthy();
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, original);
    h.authority.transaction((tx) => {
      h.authority.requireCurrent(h.input, h.actor, original, snapshot, tx);
      expect(
        readCurrentNativePrincipal(
          native,
          h.db,
          h.runtime.principal,
          tx,
          captureNativePrincipalTime(native, h.db, h.runtime.principal)
        )
      ).toBeUndefined();
    });
    expect(h.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      foreign?.$client.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      await h.cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
});

// Genuine operator controls; these do not borrow the fixture's synthetic runtime turn.
import { randomUUID } from 'node:crypto';
import { canvasDocuments, canvasDocEvents, canvasDocChannels } from '@dorkos/db';
import { docDocumentGeneration } from '../identity/incarnation.js';
import { submitCurrentDocEvent, inspectServiceCurrentDocReceipt } from '../service.js';

it('records and inspects a genuine operator original before returning its retained duplicate', async () => {
  const h = await authorityFixture(false, false, false, 'md.*');
  try {
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, h.input.documentId))
      .get()!;
    const channel = h.http.channels.getChannel(h.input.documentId)!;
    const condition = { expectedGeneration: docDocumentGeneration(physical, channel) };
    const event = {
      v: 1 as const,
      id: randomUUID(),
      type: 'md.comment',
      payload: { text: 'genuine operator' },
    };
    const before = h.db
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, h.input.documentId))
      .get()!;
    const absent = await inspectServiceCurrentDocReceipt(
      h.http.service,
      h.input.documentId,
      event.id,
      h.actor,
      condition
    );
    expect(absent).toEqual({
      kind: 'absent',
      generation: condition.expectedGeneration,
      birth: {
        physicalId: physical.id,
        openedAt: physical.openedAt,
        documentId: channel.documentId,
        createdAt: channel.createdAt,
      },
      eventId: event.id,
      receiptRetentionFloor: before.receiptRetentionFloor,
    });
    const first = await submitCurrentDocEvent(
      h.http.service,
      h.input.documentId,
      event,
      h.actor,
      condition
    );
    expect(first.receipt).toEqual({ id: event.id, status: 'recorded', docSeq: before.nextDocSeq });
    expect(first.receipt.docSeq).toBeGreaterThanOrEqual(before.receiptRetentionFloor);
    const inspected = await inspectServiceCurrentDocReceipt(
      h.http.service,
      h.input.documentId,
      event.id,
      h.actor,
      condition
    );
    expect(inspected.kind).toBe('receipt');
    if (inspected.kind !== 'receipt') throw new Error('Original receipt missing');
    expect(inspected.event.receipt).toEqual(first.receipt);
    const rows = h.db.select().from(canvasDocEvents).all();
    const after = h.db
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, h.input.documentId))
      .get();
    const duplicate = await submitCurrentDocEvent(
      h.http.service,
      h.input.documentId,
      event,
      h.actor,
      {
        ...condition,
        originalReceiptRetentionFloor: before.receiptRetentionFloor + 1,
      }
    );
    expect(duplicate.receipt).toEqual({ ...first.receipt, status: 'duplicate' });
    expect(h.db.select().from(canvasDocEvents).all()).toEqual(rows);
    expect(
      h.db
        .select()
        .from(canvasDocChannels)
        .where(eq(canvasDocChannels.documentId, h.input.documentId))
        .get()
    ).toEqual(after);
    expect(
      h.db.select().from(approvals).where(eq(approvals.id, h.granted.grant.approvalId!)).get()
        ?.consumedAt
    ).toBeTruthy();
  } finally {
    await h.cleanup();
  }
});

it('rolls a genuine fresh append back when its trigger removes a retained unrelated receipt without advancing the floor', async () => {
  const h = await originalQueuedOwnershipFixture();
  try {
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, h.input.documentId))
      .get()!;
    const channel = h.http.channels.getChannel(h.input.documentId)!;
    const condition = { expectedGeneration: docDocumentGeneration(physical, channel) };
    const retained = {
      v: 1 as const,
      id: randomUUID(),
      type: 'md.comment',
      payload: { retained: true },
    };
    await submitCurrentDocEvent(h.http.service, h.input.documentId, retained, h.actor, condition);
    const beforeRows = h.db.select().from(canvasDocEvents).all();
    const beforeChannel = h.db
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, h.input.documentId))
      .get();
    const next = { v: 1 as const, id: randomUUID(), type: 'md.comment', payload: { next: true } };
    let triggerReached = 0;
    h.db.$client.function('observe_receipt_removal', () => {
      triggerReached += 1;
      return 0;
    });
    // UUIDs are generated by the real operation; no fabricated receipt or prune is seeded.
    h.db.$client.exec(`CREATE TRIGGER remove_retained_original AFTER INSERT ON canvas_doc_events
      WHEN NEW.event_id = '${next.id}' BEGIN SELECT observe_receipt_removal(); DELETE FROM canvas_doc_events WHERE event_id = '${retained.id}'; END`);
    await expect(
      submitCurrentDocEvent(h.http.service, h.input.documentId, next, h.actor, condition)
    ).rejects.toThrow();
    expect(triggerReached).toBe(1);
    expect(h.db.select().from(canvasDocEvents).all()).toEqual(beforeRows);
    expect(
      h.db
        .select()
        .from(canvasDocChannels)
        .where(eq(canvasDocChannels.documentId, h.input.documentId))
        .get()
    ).toEqual(beforeChannel);
    expect(h.db.$client.inTransaction).toBe(false);
    h.db.$client.exec('DROP TRIGGER remove_retained_original');
    const positive = await submitCurrentDocEvent(
      h.http.service,
      h.input.documentId,
      next,
      h.actor,
      condition
    );
    expect(positive.receipt.docSeq).toBe(beforeChannel!.nextDocSeq);
  } finally {
    await h.cleanup();
  }
});

it('refuses postcommit inspection after a genuine notification closes the original channel', async () => {
  const h = await authorityFixture(false, false, false, 'md.*');
  try {
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, h.input.documentId))
      .get()!;
    const channel = h.http.channels.getChannel(h.input.documentId)!;
    const condition = { expectedGeneration: docDocumentGeneration(physical, channel) };
    const event = {
      v: 1 as const,
      id: randomUUID(),
      type: 'md.comment',
      payload: { notification: true },
    };
    const stop = h.http.service.onCommittedInput(() => {
      expect(h.db.$client.inTransaction).toBe(false);
      h.db
        .update(canvasDocChannels)
        .set({ closedAt: new Date().toISOString() })
        .where(eq(canvasDocChannels.documentId, h.input.documentId))
        .run();
    });
    await expect(
      submitCurrentDocEvent(h.http.service, h.input.documentId, event, h.actor, condition)
    ).rejects.toThrow();
    stop();
    const original = h.db
      .select()
      .from(canvasDocEvents)
      .where(eq(canvasDocEvents.eventId, event.id))
      .all();
    expect(original).toHaveLength(1);
    expect(original[0]?.docSeq).toBe(channel.nextDocSeq);
    await expect(
      inspectServiceCurrentDocReceipt(
        h.http.service,
        h.input.documentId,
        event.id,
        h.actor,
        condition
      )
    ).rejects.toThrow();
  } finally {
    await h.cleanup();
  }
});

it.each([
  { agentRoute: false, label: 'Saved in this document' },
  { agentRoute: true, label: 'This document’s agent' },
])(
  'replays genuine own-DB full birth without trusting public row or access replacement (agent route: $agentRoute)',
  async ({ agentRoute, label }) => {
    const h = await authorityFixture(false, false, agentRoute, 'md.*');
    try {
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, h.input.documentId))
        .get()!;
      const channel = h.http.channels.getChannel(h.input.documentId)!;
      const event = {
        v: 1 as const,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'retained original' },
      };
      await submitCurrentDocEvent(h.http.service, h.input.documentId, event, h.actor, {
        expectedGeneration: docDocumentGeneration(physical, channel),
      });
      h.http.channels.getEvent = () => {
        throw new Error('Public DTO is not an authoritative replay reader');
      };
      h.http.authorization.requireCurrent = () => {
        throw new Error('Public method is not the private final gate');
      };
      const replay = await h.http.service.replay(h.input.documentId, h.actor);
      // The fixed native FILE observation qualifies the original approved route.
      expect(replay.routing).toEqual({
        enabled: true,
        approvedEventTypes: ['md.*'],
        destinationLabel: label,
      });
      expect(replay.incarnation).toEqual({
        v: 1,
        documentId: h.input.documentId,
        physicalOpenedAt: physical.openedAt,
        channelCreatedAt: channel.createdAt,
        generation: docDocumentGeneration(physical, channel),
      });
      expect(replay.receipts.some((row) => row.receipt.id === event.id)).toBe(true);
      expect(replay.events.some((row) => row.event.id === event.id)).toBe(true);
      expect(Object.isFrozen(replay)).toBe(true);
      expect(
        (await readServiceOriginalDocManagement(h.http.service, h.input.documentId, h.actor))
          .routing
      ).toEqual(replay.routing);
      h.db
        .update(canvasDocuments)
        .set({ resolvedCwd: join(h.dir, 'foreign-source') })
        .where(eq(canvasDocuments.id, h.input.documentId))
        .run();
      await expect(h.http.service.replay(h.input.documentId, h.actor)).rejects.toThrow();
      await expect(
        readServiceOriginalDocManagement(h.http.service, h.input.documentId, h.actor)
      ).rejects.toThrow();
      h.db
        .update(canvasDocuments)
        .set({ resolvedCwd: physical.resolvedCwd })
        .where(eq(canvasDocuments.id, h.input.documentId))
        .run();
      expect((await h.http.service.replay(h.input.documentId, h.actor)).routing).toEqual(
        replay.routing
      );
      h.db
        .update(canvasDocGrants)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(canvasDocGrants.grantId, h.granted.grant.grantId))
        .run();
      const savedOnly = {
        enabled: false,
        approvedEventTypes: [],
        destinationLabel: 'Approval needed',
      };
      expect((await h.http.service.replay(h.input.documentId, h.actor)).routing).toEqual(savedOnly);
      expect(
        (await readServiceOriginalDocManagement(h.http.service, h.input.documentId, h.actor))
          .routing
      ).toEqual(savedOnly);
      h.db
        .update(canvasDocChannels)
        .set({ closedAt: new Date().toISOString() })
        .where(eq(canvasDocChannels.documentId, h.input.documentId))
        .run();
      await expect(h.http.service.replay(h.input.documentId, h.actor)).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  }
);

import { DocChannelStore } from '../store.js';
import { DocChannelService } from '../service.js';
it('refuses a foreign migrated FILE replay store before disclosing birth', async () => {
  const h = await authorityFixture();
  let foreign: ReturnType<typeof createDb> | undefined;
  let failed = false,
    first: unknown;
  try {
    foreign = createDb(join(h.dir, 'replay-foreign.sqlite'));
    const actualForeign = foreign;
    runMigrations(actualForeign);
    expect(
      () =>
        new DocChannelService(
          h.rooms.canvasDocuments,
          new DocChannelStore(actualForeign),
          h.http.authorization
        )
    ).toThrow('genuine store transaction database');
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      foreign?.$client.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      await h.cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
});
it('refuses malformed current persisted replay state instead of minting a birth observation', async () => {
  const h = await authorityFixture();
  try {
    h.db.$client
      .prepare('UPDATE canvas_doc_channels SET state = ? WHERE document_id = ?')
      .run('{', h.input.documentId);
    await expect(h.http.service.replay(h.input.documentId, h.actor)).rejects.toThrow();
    expect(h.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

import { replayServiceCurrentDoc } from '../service.js';
import { projectCurrentMcpOrigin } from '../replay.js';

it('projects only the authenticated stored session MCP origin with the same full birth and declaration', async () => {
  const h = await authorityFixture(false, false, false, 'md.*');
  try {
    const documentId = h.input.documentId;
    // Synthetic physical-content setup does not issue an extension or alter the genuine consumed approval.
    h.db
      .update(canvasDocuments)
      .set({
        contentType: 'mcp_app',
        content: { type: 'mcp_app', serverName: 'stored-server', uri: 'ui://stored-resource' },
      })
      .where(eq(canvasDocuments.id, documentId))
      .run();
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, documentId))
      .get()!;
    const channel = h.http.channels.getChannel(documentId)!;
    const replay = await replayServiceCurrentDoc(h.http.service, documentId, h.actor);
    // The old FILE approval must not advertise writes on the now non-FILE source.
    expect(replay.routing).toEqual({
      enabled: false,
      approvedEventTypes: [],
      destinationLabel: 'Approval needed',
    });
    expect(replay.mcpOrigin).toEqual({
      canonicalSessionId: channel.scope.slice('session:'.length),
      serverName: 'stored-server',
      uri: 'ui://stored-resource',
      physicalRevision: physical.rev,
      declaration: channel.declaration,
      declarationHash: channel.declarationHash,
    });
    expect(replay.incarnation).toEqual({
      v: 1,
      documentId,
      physicalOpenedAt: physical.openedAt,
      channelCreatedAt: channel.createdAt,
      generation: docDocumentGeneration(physical, channel),
    });
    // Pure data refusal: Room has no persisted originating session in this source schema.
    expect(
      projectCurrentMcpOrigin(
        { ...physical, roomId: 'room-with-no-origin' },
        channel,
        'room:room-with-no-origin'
      )
    ).toBeUndefined();
    expect(
      projectCurrentMcpOrigin(physical, { ...channel, declarationHash: 'corrupt' }, channel.scope)
    ).toBeUndefined();
    expect(h.db.select().from(canvasDocEvents).all()).toEqual([]);
    expect(h.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
    expect(
      h.db.select().from(approvals).where(eq(approvals.id, h.granted.grant.approvalId!)).get()
        ?.consumedAt
    ).toBeTruthy();
  } finally {
    await h.cleanup();
  }
});

// Full-slice data controls use genuine consumed approval and the fixed current submit path.
// They do not claim a Room operator producer binding or a dispatched Room turn.
import { sql, type DbTransaction } from '@dorkos/db';
import {
  captureCurrentBatchOriginalInputs,
  requireCurrentQueueMembership,
} from '../current/current-operation-intentions.js';
for (const mutation of [
  'extra receipt',
  'missing receipt',
  'retained-column rewrite',
  'pruned original',
] as const) {
  it(`refuses ${mutation} in the complete original batch slice and rolls its SQL back`, async () => {
    const h = await originalQueuedOwnershipFixture();
    try {
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, h.input.documentId))
        .get()!;
      const channel = h.http.channels.getChannel(h.input.documentId)!;
      const id = randomUUID();
      const receipt = await submitCurrentDocEvent(
        h.http.service,
        h.input.documentId,
        { v: 1, id, type: 'md.comment', payload: { text: 'original full-slice control' } },
        h.actor,
        { expectedGeneration: docDocumentGeneration(physical, channel) }
      );
      const delivery = receipt.deliveries.find((row) => row.batchId)!;
      expect(delivery.batchId).toBeTruthy();
      const batch = h.http.channels.getBatch(delivery.batchId!)!;
      const beforeEvents = h.db.select().from(canvasDocEvents).all();
      let reached = false;
      const attack = (tx: DbTransaction) => {
        const original = captureCurrentBatchOriginalInputs(tx, batch);
        requireCurrentQueueMembership(
          tx,
          batch.batchId,
          original.map((input) => input.delivery)
        );
        if (mutation === 'extra receipt')
          tx.run(sql`
          INSERT INTO canvas_doc_deliveries(document_id,event_id,route_id,batch_id,status,reason,turn_id,
            ack_outcome,ack_evidence,acknowledged_at,acknowledged_by,updated_at)
          SELECT document_id,event_id,route_id||'-unexpected',batch_id,status,reason,turn_id,
            ack_outcome,ack_evidence,acknowledged_at,acknowledged_by,updated_at
          FROM canvas_doc_deliveries WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId}`);
        if (mutation === 'missing receipt')
          tx.run(sql`DELETE FROM canvas_doc_deliveries
          WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId}`);
        if (mutation === 'retained-column rewrite')
          tx.run(sql`UPDATE canvas_doc_deliveries
          SET updated_at='2026-10-03T00:00:00.000Z' WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId}`);
        if (mutation === 'pruned original')
          tx.run(sql`UPDATE canvas_doc_events
          SET payload_pruned_at='2026-10-03T00:00:00.000Z' WHERE document_id=${batch.documentId} AND event_id=${id}`);
        reached = true;
        if (mutation === 'pruned original') captureCurrentBatchOriginalInputs(tx, batch);
        else
          requireCurrentQueueMembership(
            tx,
            batch.batchId,
            original.map((input) => input.delivery)
          );
      };
      expect(() => h.http.channels.transaction(attack)).toThrow(
        mutation === 'pruned original' ? 'full correlated receipt' : 'cardinality/content changed'
      );
      expect(reached).toBe(true);
      expect(h.db.select().from(canvasDocEvents).all()).toEqual(beforeEvents);
      expect(h.http.channels.getBatch(batch.batchId)).toEqual(batch);
      expect(h.http.channels.listDeliveries(batch.documentId, id)).toHaveLength(
        receipt.deliveries.length
      );
      h.http.channels.transaction((tx) =>
        requireCurrentQueueMembership(
          tx,
          batch.batchId,
          captureCurrentBatchOriginalInputs(tx, batch).map((input) => input.delivery)
        )
      );
      expect(
        h.db.select().from(approvals).where(eq(approvals.id, h.granted.grant.approvalId!)).get()
          ?.consumedAt
      ).toBeTruthy();
    } finally {
      await h.cleanup();
    }
  });
}

it.each(['after open', 'after migration'] as const)(
  'drains both genuine FILE owners after foreign setup throws undefined: %s',
  async (phase) => {
    const h = await authorityFixture();
    let foreign: ReturnType<typeof createDb> | undefined;
    let failed = false,
      first: unknown;
    let fixtureCleanupAttempted = false;
    const setup = async () => {
      // Join this scope to its captured cleanup before returning or reporting failure.
      const drainOriginalCleanup = async () => {
        try {
          foreign?.$client.close();
          throw new Error('secondary cleanup after actual foreign closure');
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
        try {
          fixtureCleanupAttempted = true;
          await h.cleanup();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      try {
        foreign = createDb(join(h.dir, 'failed-foreign.sqlite'));
        if (phase === 'after migration') runMigrations(foreign);
        throw undefined;
      } catch (cause) {
        failed = true;
        first = cause;
      } finally {
        await drainOriginalCleanup();
      }
      if (failed) throw first;
    };
    await expect(setup()).rejects.toBeUndefined();
    expect(fixtureCleanupAttempted).toBe(true);
    expect(foreign?.$client.open).toBe(false);
    expect(h.db.$client.open).toBe(false);
    const fs = await import('node:fs/promises');
    await expect(fs.stat(h.dir)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);

import {
  captureServiceCurrentDocument,
  requireServiceCurrentDocument,
  replayServiceDocumentAuthority,
  inspectServiceDocumentAuthority,
} from '../service.js';
it('captures empty-route document custody through the real operator owner and refuses copied or closed birth', async () => {
  const h = await authorityFixture(false, false, false, 'md.*');
  let failed = false,
    first: unknown;
  try {
    const captured = await captureServiceCurrentDocument(
      h.http.service,
      h.input.documentId,
      h.actor,
      []
    );
    expect(
      (await requireServiceCurrentDocument(h.http.service, captured.authority)).generation
    ).toBe(captured.generation);
    expect(
      (await replayServiceDocumentAuthority(h.http.service, captured.authority)).incarnation
        .documentId
    ).toBe(h.input.documentId);
    const missing = await inspectServiceDocumentAuthority(
      h.http.service,
      captured.authority,
      randomUUID()
    );
    expect(missing.kind).toBe('absent');
    await expect(
      Promise.resolve().then(() =>
        requireServiceCurrentDocument(h.http.service, { ...captured.authority })
      )
    ).rejects.toThrow();
    h.db
      .update(canvasDocChannels)
      .set({ closedAt: new Date().toISOString() })
      .where(eq(canvasDocChannels.documentId, h.input.documentId))
      .run();
    await expect(
      requireServiceCurrentDocument(h.http.service, captured.authority)
    ).rejects.toThrow();
    await expect(
      replayServiceDocumentAuthority(h.http.service, captured.authority)
    ).rejects.toThrow();
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      await h.cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
});

import * as nativeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { env as serverEnv } from '../../../../env.js';
import {
  RuntimeRegistry,
  readOriginalRegisteredRuntime,
  observeOriginalRegisteredRuntimeStream,
} from '../../../core/runtime-registry.js';
import {
  TestModeRuntime,
  captureTestModeOriginalRoomEmitter,
  sendTestModeOriginalLockedMessage,
  resolveTestModeOriginalNativeStreamPrincipal,
  readTestModeOriginalNativeStream,
  readTestModeOriginalScenarioEvidence,
  readTestModeOriginalStopTerminalData,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import {
  scenarioStore,
  declareInterruptOutcome,
  declaredInterruptOutcome,
} from '../../../runtimes/test-mode/scenario-store.js';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';

/** Use the same installed native Room owner, declaration and consumed approval for queue controls. */
async function originalQueuedOwnershipFixture() {
  const dir = await nativeFs.realpath(
    await nativeFs.mkdtemp(join(tmpdir(), 'original-queued-custody-'))
  );
  const prior = serverEnv.DORKOS_TEST_RUNTIME;
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    const original = await nativeRoomAuthorityFixture(
      dir,
      'claude-code',
      randomUUID(),
      randomUUID()
    );
    return { ...original, input: { documentId: original.documentId }, actor: original.operator };
  } finally {
    serverEnv.DORKOS_TEST_RUNTIME = prior;
  }
}

it('keeps genuine registered TestMode native stream identity and retires a held replaced selection before another scenario entry', async () => {
  const dir = await nativeFs.mkdtemp(join(tmpdir(), 'original-testmode-registry-'));
  const wasTestMode = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let runtime: TestModeRuntime | undefined;
  let raw: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
  let observed: typeof raw;
  const sessionId = randomUUID(),
    agentId = randomUUID(),
    holder = { on: () => {} };
  let failed = false,
    first: unknown;
  const cleanup = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, agentId);
    runtime = new TestModeRuntime('claude-code', h.principals);
    const registry = new RuntimeRegistry();
    registry.register(runtime);
    const selected = registry.get('claude-code');
    expect(readOriginalRegisteredRuntime(selected)).toBe(runtime);
    expect(runtime.acquireLock(sessionId, 'original-held-native', holder)).toBe(true);
    scenarioStore.setForSession(sessionId, 'simple-text');
    raw = sendTestModeOriginalLockedMessage(
      selected,
      sessionId,
      'actual local scenario',
      { cwd: dir },
      holder,
      sessionId
    );
    if (!raw) throw new Error('Genuine TestMode native constructor not recognized.');
    expect(readTestModeOriginalNativeStream(selected, raw)).toBeDefined();
    expect(readTestModeOriginalNativeStream({ ...selected }, raw)).toBeUndefined();
    observed = observeOriginalRegisteredRuntimeStream(selected, sessionId, raw);
    expect((await observed.next()).done).toBe(false);
    expect((await resolveTestModeOriginalNativeStreamPrincipal(selected, observed)).status).toBe(
      'resolved'
    );
    expect(readTestModeOriginalScenarioEvidence(runtime, raw)?.scenarioStarts).toBe(1);
    registry.register(new TestModeRuntime('claude-code', h.principals));
    expect(readOriginalRegisteredRuntime(selected)).toBeUndefined();
    await expect(observed.next()).rejects.toThrow('Original runtime selection retired');
    expect(readTestModeOriginalNativeStream(runtime, raw)).toBeUndefined();
    expect(readTestModeOriginalScenarioEvidence(runtime, raw)).toMatchObject({
      scenarioStarts: 1,
      retired: true,
    });
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    await cleanup(() => observed?.return(undefined));
    await cleanup(() => raw?.return(undefined));
    await cleanup(() => runtime?.releaseLock(sessionId, 'original-held-native'));
    await cleanup(() => scenarioStore.clearSession(sessionId));
    await cleanup(() => h?.cleanup());
    await cleanup(() => nativeFs.rm(dir, { recursive: true, force: true }));
    serverEnv.DORKOS_TEST_RUNTIME = wasTestMode;
  }
  if (failed) throw first;
});

import { currentRoomDueServicePort, readServiceOriginalRoomScenarioEvidence } from '../service.js';
import { user as operatorOwnerRows } from '@dorkos/db';
import { findOwnerAccount } from '../../../core/auth/accounts.js';
import { reopenNativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';

it('retires the original lazy pump before its first construction while preserving ordinary document reads', async () => {
  const dir = await nativeFs.mkdtemp(join(tmpdir(), 'original-lazy-stop-'));
  const oldTestMode = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let port: ReturnType<typeof currentRoomDueServicePort> | undefined;
  let failed = false,
    first: unknown;
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', randomUUID(), randomUUID());
    const runtime = new TestModeRuntime('claude-code', h.principals),
      registry = new RuntimeRegistry();
    registry.setDb(h.db);
    registry.register(runtime);
    port = currentRoomDueServicePort(h.http.service);
    await port.stopPump();
    expect(port.nextDueAt()).toBeUndefined();
    port.wake();
    await port.pump(registry);
    await port.stopPump();
    const replay = await replayServiceCurrentDoc(h.http.service, h.documentId, h.operator);
    expect(replay.incarnation.documentId).toBe(h.documentId);
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, h.documentId))
      .get()!;
    const channel = h.http.channels.getChannel(h.documentId)!;
    const id = randomUUID();
    await expect(
      submitCurrentDocEvent(
        h.http.service,
        h.documentId,
        { v: 1, id, type: 'md.comment', payload: { text: 'after original pump retirement' } },
        h.operator,
        { expectedGeneration: docDocumentGeneration(physical, channel) }
      )
    ).rejects.toThrow('pump admission is stopped');
    expect(
      h.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM canvas_doc_events WHERE event_id=${id}`
      )!.n
    ).toBe(0);
    expect(
      h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM connector_runtime_bindings`)!.n
    ).toBe(0);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(0);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    for (const work of [
      () => port?.stopPump(),
      () => h?.cleanup(),
      () => nativeFs.rm(dir, { recursive: true, force: true }),
    ])
      try {
        await work();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    serverEnv.DORKOS_TEST_RUNTIME = oldTestMode;
  }
  if (failed) throw first;
});

it('reacquires the same accepted operator source on real FILE reopen without reopening its HTTP principal or repeating a started turn', async () => {
  const dir = await nativeFs.mkdtemp(join(tmpdir(), 'original-operator-reopen-'));
  const oldTestMode = serverEnv.DORKOS_TEST_RUNTIME;
  let original: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let reopened: Awaited<ReturnType<typeof reopenNativeRoomAuthorityFixture>> | undefined;
  let oldPort: ReturnType<typeof currentRoomDueServicePort> | undefined;
  let newPort: typeof oldPort;
  let failed = false,
    first: unknown;
  const attempt = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  const sessionId = randomUUID(),
    agentId = randomUUID();
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    original = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, agentId);
    const doc = original.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, original.documentId))
      .get()!;
    const channel = original.http.channels.getChannel(original.documentId)!;
    const event = {
      v: 1 as const,
      id: randomUUID(),
      type: 'md.comment',
      payload: { text: 'durable operator origin' },
    };
    await submitCurrentDocEvent(
      original.http.service,
      original.documentId,
      event,
      original.operator,
      { expectedGeneration: docDocumentGeneration(doc, channel) }
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 110));
    oldPort = currentRoomDueServicePort(original.http.service);
    oldPort.wake();
    const stored = original.db.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_batches
      WHERE document_id=${original.documentId}`)!;
    expect(stored.status).toBe('accepted');
    expect(typeof stored.room_admission_id).toBe('string');
    expect(stored.room_admission_id).not.toBe('');
    expect(original.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      0
    );
    await oldPort.stopPump();
    original.db.$client.close();
    // Production constructors on the same FILE, with a new native ticket/boot; no copied source is supplied.
    reopened = await reopenNativeRoomAuthorityFixture(original);
    const raw = new TestModeRuntime('claude-code', reopened.principals);
    captureTestModeOriginalRoomEmitter(
      raw,
      reopened.http.fileWrites,
      reopened.db,
      reopened.http.channels
    );
    const registry = new RuntimeRegistry();
    registry.setDb(reopened.db);
    registry.register(raw);
    scenarioStore.setForSession(sessionId, 'simple-text');
    newPort = currentRoomDueServicePort(reopened.http.service);
    await newPort.pump(registry);
    const after = reopened.db.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_batches
      WHERE batch_id=${String(stored.batch_id)}`)!;
    for (const key of [
      'batch_id',
      'generation',
      'room_admission_id',
      'room_source_attempt',
      'room_source_json',
      'room_source_hash',
    ])
      expect(after[key]).toEqual(stored[key]);
    expect(after.status).toBe('turn_done');
    expect(reopened.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      1
    );
    expect(
      readServiceOriginalRoomScenarioEvidence(
        reopened.http.service,
        original.documentId,
        String(stored.batch_id),
        String(stored.generation)
      )
    ).toMatchObject({ scenarioStarts: 1, retired: true });
    await newPort.pump(registry);
    expect(reopened.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      1
    );
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    await attempt(() => newPort?.stopPump());
    await attempt(() => oldPort?.stopPump());
    await attempt(() => scenarioStore.clearSession(sessionId));
    await attempt(() => reopened?.cleanup());
    await attempt(() => original?.cleanup());
    await attempt(() => nativeFs.rm(dir, { recursive: true, force: true }));
    serverEnv.DORKOS_TEST_RUNTIME = oldTestMode;
  }
  if (failed) throw first;
});

it('honors retirement from genuine accepted-source membership during FILE reopen construction before any scenario starts', async () => {
  const dir = await nativeFs.mkdtemp(join(tmpdir(), 'original-operator-reopen-'));
  const oldTestMode = serverEnv.DORKOS_TEST_RUNTIME;
  let original: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let reopened: Awaited<ReturnType<typeof reopenNativeRoomAuthorityFixture>> | undefined;
  let oldPort: ReturnType<typeof currentRoomDueServicePort> | undefined;
  let newPort: typeof oldPort;
  let membershipSpy: ReturnType<typeof vi.spyOn> | undefined;
  let stoppedDuringConstruction: Promise<void> | undefined;
  let failed = false,
    first: unknown;
  const attempt = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  const sessionId = randomUUID(),
    agentId = randomUUID();
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    original = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, agentId);
    const doc = original.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, original.documentId))
      .get()!;
    const channel = original.http.channels.getChannel(original.documentId)!;
    const event = {
      v: 1 as const,
      id: randomUUID(),
      type: 'md.comment',
      payload: { text: 'durable operator origin' },
    };
    await submitCurrentDocEvent(
      original.http.service,
      original.documentId,
      event,
      original.operator,
      { expectedGeneration: docDocumentGeneration(doc, channel) }
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 110));
    oldPort = currentRoomDueServicePort(original.http.service);
    oldPort.wake();
    const stored = original.db.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_batches
      WHERE document_id=${original.documentId}`)!;
    expect(stored.status).toBe('accepted');
    expect(typeof stored.room_admission_id).toBe('string');
    expect(stored.room_admission_id).not.toBe('');
    expect(original.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      0
    );
    await oldPort.stopPump();
    original.db.$client.close();
    // Production constructors on the same FILE, with a new native ticket/boot; no copied source is supplied.
    reopened = await reopenNativeRoomAuthorityFixture(original);
    const raw = new TestModeRuntime('claude-code', reopened.principals);
    const registry = new RuntimeRegistry();
    registry.setDb(reopened.db);
    registry.register(raw);
    scenarioStore.setForSession(sessionId, 'simple-text');
    newPort = currentRoomDueServicePort(reopened.http.service);
    const actualMembership = reopened.rooms.service.requireMembership.bind(reopened.rooms.service);
    membershipSpy = vi
      .spyOn(reopened.rooms.service, 'requireMembership')
      .mockImplementation((...args) => {
        const membership = actualMembership(...args);
        // Genuine original membership delegates first, then retires the engine while its native constructor is held.
        stoppedDuringConstruction ??= newPort!.stopPump();
        return membership;
      });
    await newPort.pump(registry);
    expect(stoppedDuringConstruction).toBeDefined();
    await stoppedDuringConstruction;
    const after = reopened.db.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_batches
      WHERE batch_id=${String(stored.batch_id)}`)!;
    for (const key of [
      'batch_id',
      'generation',
      'room_admission_id',
      'room_source_attempt',
      'room_source_json',
      'room_source_hash',
    ])
      expect(after[key]).toEqual(stored[key]);
    expect(after.status).toBe('accepted');
    expect(reopened.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      0
    );
    expect(
      readServiceOriginalRoomScenarioEvidence(
        reopened.http.service,
        original.documentId,
        String(stored.batch_id),
        String(stored.generation)
      )
    ).toBeUndefined();
    await newPort.pump(registry);
    expect(reopened.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      0
    );
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    await attempt(() => membershipSpy?.mockRestore());
    await attempt(() => stoppedDuringConstruction);
    await attempt(() => newPort?.stopPump());
    await attempt(() => oldPort?.stopPump());
    await attempt(() => scenarioStore.clearSession(sessionId));
    await attempt(() => reopened?.cleanup());
    await attempt(() => original?.cleanup());
    await attempt(() => nativeFs.rm(dir, { recursive: true, force: true }));
    serverEnv.DORKOS_TEST_RUNTIME = oldTestMode;
  }
  if (failed) throw first;
});

for (const ownerLoss of [false, true]) {
  it(`keeps genuine operator Room acceptance independent of its request and ${ownerLoss ? 'refuses changed owner before native start' : 'starts the same native TestMode entry once after COMMIT/FIRST'}`, async () => {
    const dir = await nativeFs.mkdtemp(join(tmpdir(), 'original-operator-room-'));
    const oldTestMode = serverEnv.DORKOS_TEST_RUNTIME;
    let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
    let port: ReturnType<typeof currentRoomDueServicePort> | undefined;
    let failed = false,
      first: unknown;
    const attempt = async (work: () => unknown | Promise<unknown>) => {
      try {
        await work();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    try {
      serverEnv.DORKOS_TEST_RUNTIME = true;
      const sessionId = randomUUID(),
        agentId = randomUUID();
      h = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, agentId);
      const runtime = new TestModeRuntime('claude-code', h.principals);
      captureTestModeOriginalRoomEmitter(runtime, h.http.fileWrites, h.db, h.http.channels);
      const registry = new RuntimeRegistry();
      registry.setDb(h.db);
      registry.register(runtime);
      scenarioStore.setForSession(sessionId, 'simple-text');
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, h.documentId))
        .get()!;
      const channel = h.http.channels.getChannel(h.documentId)!;
      const event = {
        v: 1 as const,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'original operator accepted source' },
      };
      const accepted = await submitCurrentDocEvent(
        h.http.service,
        h.documentId,
        event,
        h.operator,
        { expectedGeneration: docDocumentGeneration(physical, channel) }
      );
      expect(accepted.receipt.id).toBe(event.id);
      const before = h.db.get<{
        batch_id: string;
        generation: string;
        room_admission_id: string | null;
      }>(sql`
        SELECT b.batch_id,b.generation,b.room_admission_id FROM canvas_doc_batches b
        JOIN canvas_doc_deliveries d ON d.batch_id=b.batch_id WHERE d.event_id=${event.id}`)!;
      expect(before.room_admission_id).toBeNull();
      // No principal/turn is kept alive by the test. The original committed input is private source custody.
      if (ownerLoss)
        h.db
          .insert(operatorOwnerRows)
          .values({
            id: 'new-authenticated-owner',
            name: 'Owner',
            email: 'owner-change@example.test',
            // Native boot already owns the first authenticated account. Make this
            // deliberate storage mutation change the actual earliest-owner policy.
            createdAt: new Date(0),
            updatedAt: new Date(),
          })
          .run();
      if (ownerLoss) expect(findOwnerAccount(h.db)?.id).toBe('new-authenticated-owner');
      await new Promise<void>((resolve) => setTimeout(resolve, 110));
      port = currentRoomDueServicePort(h.http.service);
      port.wake();
      await port.pump(registry);
      const spend = h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n;
      const after = h.db.get<{ batch_id: string; generation: string; status: string }>(sql`
        SELECT batch_id,generation,status FROM canvas_doc_batches WHERE batch_id=${before.batch_id}`)!;
      expect(after.batch_id).toBe(before.batch_id);
      expect(after.generation).toBe(before.generation);
      if (ownerLoss) {
        expect(spend).toBe(0);
        expect(
          readServiceOriginalRoomScenarioEvidence(
            h.http.service,
            h.documentId,
            before.batch_id,
            before.generation
          )
        ).toBeUndefined();
        expect(
          h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM connector_runtime_bindings`)!.n
        ).toBe(0);
      } else {
        expect(spend).toBe(1);
        expect(
          readServiceOriginalRoomScenarioEvidence(
            h.http.service,
            h.documentId,
            before.batch_id,
            before.generation
          )
        ).toMatchObject({ scenarioStarts: 1, retired: true });
        expect(after.status).toBe('turn_done');
        await port.pump(registry);
        expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
        expect(
          readServiceOriginalRoomScenarioEvidence(
            h.http.service,
            h.documentId,
            before.batch_id,
            before.generation
          )?.scenarioStarts
        ).toBe(1);
      }
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      await attempt(() => port?.stopPump());
      await attempt(() => h?.cleanup());
      await attempt(() => nativeFs.rm(dir, { recursive: true, force: true }));
      serverEnv.DORKOS_TEST_RUNTIME = oldTestMode;
    }
    if (failed) throw first;
  });
}

it('projects only freshly approved original Room routing and removes readiness after native revocation', async () => {
  const dir = await nativeFs.realpath(
    await nativeFs.mkdtemp(join(tmpdir(), 'original-replay-routing-'))
  );
  const prior = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let failed = false;
  let first: unknown;
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', randomUUID(), randomUUID());
    // Public method replacement cannot approve a route in the fixed replay path.
    h.http.grants.getCurrentRoutes = () => {
      throw new Error('Public routing replacement');
    };
    const ready = await replayServiceCurrentDoc(h.http.service, h.documentId, h.operator);
    expect(ready.routing).toEqual({
      enabled: true,
      approvedEventTypes: ['md.*'],
      destinationLabel: 'Room',
    });
    h.db
      .update(canvasDocGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(canvasDocGrants.grantId, h.granted.grant.grantId))
      .run();
    const savedOnly = await replayServiceCurrentDoc(h.http.service, h.documentId, h.operator);
    expect(savedOnly.routing).toEqual({
      enabled: false,
      approvedEventTypes: [],
      destinationLabel: 'Approval needed',
    });
    expect(savedOnly.incarnation).toEqual(ready.incarnation);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      if (h) await h.cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    serverEnv.DORKOS_TEST_RUNTIME = prior;
  }
  if (failed) throw first;
});

import { SessionStateProjector } from '../../../session/session-state-projector.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';

it.each(['pending-read', 'between-reads', 'replaced-selection'] as const)(
  'drains only original stopped terminal DATA with retired native authority: %s',
  async (mode) => {
    const dir = await nativeFs.realpath(
      await nativeFs.mkdtemp(join(tmpdir(), 'original-stop-terminal-'))
    );
    const oldMode = serverEnv.DORKOS_TEST_RUNTIME,
      oldOutcome = declaredInterruptOutcome();
    const sessionId = randomUUID(),
      agentId = randomUUID(),
      holder = { on: () => {} };
    let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
    let runtime: TestModeRuntime | undefined;
    let raw: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
    let observed: typeof raw;
    let pending: ReturnType<NonNullable<typeof raw>['next']> | undefined;
    let failed = false,
      first: unknown;
    const cleanup = async (work: () => unknown | Promise<unknown>) => {
      try {
        await work();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    try {
      serverEnv.DORKOS_TEST_RUNTIME = true;
      declareInterruptOutcome(undefined);
      h = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, agentId);
      runtime = new TestModeRuntime('claude-code', h.principals);
      const registry = new RuntimeRegistry();
      registry.register(runtime);
      const selected = registry.get('claude-code');
      expect(runtime.acquireLock(sessionId, 'original-stop-terminal', holder)).toBe(true);
      scenarioStore.setForSession(sessionId, 'stoppable-turn');
      raw = sendTestModeOriginalLockedMessage(
        selected,
        sessionId,
        'stop the actual held scenario',
        { cwd: dir },
        holder,
        sessionId
      );
      if (!raw) throw new Error('Original constructor stream required');
      observed = observeOriginalRegisteredRuntimeStream(selected, sessionId, raw);
      const opening = await observed.next(),
        marker = await observed.next();
      if (opening.done || marker.done) throw new Error('Actual stoppable scenario did not enter');
      expect(marker.value).toMatchObject({
        type: 'text_delta',
        data: { text: expect.stringContaining('STOPPABLE-TURN') },
      });
      expect(readTestModeOriginalNativeStream(selected, raw)).toBeDefined();
      if (mode !== 'between-reads') {
        pending = observed.next();
        void pending.catch(() => {});
      }
      await expect(runtime.interruptQuery(sessionId)).resolves.toMatchObject({ outcome: 'closed' });
      expect(readTestModeOriginalNativeStream(selected, raw)).toBeUndefined();
      expect((await resolveTestModeOriginalNativeStreamPrincipal(selected, raw)).status).toBe(
        'refused'
      );
      if (mode === 'replaced-selection') {
        registry.register(new TestModeRuntime('claude-code', h.principals));
        await expect(pending!).rejects.toThrow('Original runtime selection retired');
        pending = undefined;
      } else {
        const terminal = await (pending ?? observed.next());
        pending = undefined;
        if (terminal.done) throw new Error('Original interrupted terminal missing');
        expect(terminal.value).toMatchObject({
          type: 'session_status',
          data: { terminalReason: 'aborted_streaming' },
        });
        expect(readTestModeOriginalStopTerminalData(runtime, raw, terminal.value)).toBe(true);
        // Caller mutation cannot change the branded original terminal data.
        expect(Reflect.set(terminal.value, 'type', 'text_delta')).toBe(false);
        expect(Reflect.set(terminal.value.data, 'terminalReason', 'completed')).toBe(false);
        expect(readTestModeOriginalStopTerminalData(runtime, raw, terminal.value)).toBe(true);
        // Prototype replacement cannot redirect the private original-entry lookup.
        const originalGet = Map.prototype.get;
        try {
          Map.prototype.get = () => undefined;
          expect(readTestModeOriginalStopTerminalData(runtime, raw, terminal.value)).toBe(true);
        } finally {
          Map.prototype.get = originalGet;
        }
        expect(readTestModeOriginalStopTerminalData(runtime, raw, { ...terminal.value })).toBe(
          false
        );
        expect(readTestModeOriginalStopTerminalData({ ...runtime }, raw, terminal.value)).toBe(
          false
        );
        expect(readTestModeOriginalStopTerminalData(runtime, {}, terminal.value)).toBe(false);
        const done = await observed.next();
        if (done.done) throw new Error('Original done event missing');
        expect(done.value.type).toBe('done');
        expect(await observed.next()).toEqual({ done: true, value: undefined });
        expect(readTestModeOriginalStopTerminalData(runtime, raw, terminal.value)).toBe(false);
        const projector = new SessionStateProjector(sessionId);
        await feedProjector(
          projector,
          (async function* () {
            yield opening.value;
            yield marker.value;
            yield terminal.value;
            yield done.value;
          })()
        );
        expect(projector.getStatus().lifecycle).toBe('interrupted');
        expect(projector.replayFrom(0).filter((event) => event.type === 'turn_end')).toHaveLength(
          1
        );
        expect(projector.replayFrom(0).filter((event) => event.type === 'error')).toHaveLength(0);
        expect(readTestModeOriginalScenarioEvidence(runtime, raw)).toMatchObject({
          scenarioStarts: 1,
          retired: true,
        });
      }
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      await cleanup(() => runtime?.interruptQuery(sessionId));
      await cleanup(() => observed?.return(undefined));
      await cleanup(() => raw?.return(undefined));
      await cleanup(() => pending);
      await cleanup(() => runtime?.releaseLock(sessionId, 'original-stop-terminal'));
      await cleanup(() => scenarioStore.clearSession(sessionId));
      await cleanup(() => h?.cleanup());
      await cleanup(() => nativeFs.rm(dir, { recursive: true, force: true }));
      declareInterruptOutcome(oldOutcome);
      serverEnv.DORKOS_TEST_RUNTIME = oldMode;
    }
    if (failed) throw first;
  }
);

it('records tool audit events from the genuine already opened native stream without a second runtime entry', async () => {
  const { initAuditTrail, resetAuditTrail } = await import('../../../audit/audit-trail.js');
  const { AuditLog } = await import('../../../audit/audit-log.js');
  const { AccountIds } = await import('../../../audit/account-ids.js');
  const { resetRecordedToolCalls } = await import('../../../audit/record-tool-use.js');
  const { auditEvents } = await import('@dorkos/db');
  const dir = await nativeFs.realpath(
    await nativeFs.mkdtemp(join(tmpdir(), 'native-stream-audit-'))
  );
  const prior = serverEnv.DORKOS_TEST_RUNTIME;
  const sessionId = randomUUID(),
    agentId = randomUUID(),
    clientId = 'native-stream-audit';
  const holder = { on: () => {} };
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let runtime: TestModeRuntime | undefined;
  let raw: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
  let observed: typeof raw;
  let failed = false,
    first: unknown;
  const cleanup = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, agentId);
    resetRecordedToolCalls();
    initAuditTrail({
      log: new AuditLog(h.db),
      accounts: new AccountIds({
        db: h.db,
        installId: 'native-stream-audit',
        readOwnerAccount: () => null,
      }),
    });
    runtime = new TestModeRuntime('claude-code', h.principals);
    const registry = new RuntimeRegistry();
    registry.setDb(h.db);
    registry.register(runtime);
    const selected = registry.get('claude-code');
    expect(runtime.acquireLock(sessionId, clientId, holder)).toBe(true);
    scenarioStore.setForSession(sessionId, 'tool-call');
    raw = sendTestModeOriginalLockedMessage(
      selected,
      sessionId,
      'actual tool scenario',
      { cwd: dir },
      holder,
      sessionId
    );
    if (!raw) throw new Error('Genuine native tool stream unavailable.');
    expect(readTestModeOriginalNativeStream({ ...selected }, raw)).toBeUndefined();
    expect(() => observeOriginalRegisteredRuntimeStream({ ...selected }, sessionId, raw!)).toThrow(
      'Current original registered native stream'
    );
    observed = observeOriginalRegisteredRuntimeStream(selected, sessionId, raw);
    const firstEvent = await observed.next();
    expect(firstEvent.done).toBe(false);
    expect((await resolveTestModeOriginalNativeStreamPrincipal(selected, observed)).status).toBe(
      'resolved'
    );
    for await (const _event of observed) {
      /* drain the same original stream */
    }
    expect(readTestModeOriginalScenarioEvidence(runtime, raw)?.scenarioStarts).toBe(1);
    expect(
      h.db
        .select()
        .from(auditEvents)
        .all()
        .filter((row) => row.action === 'runtime.tool_used')
        .map((row) => [row.action, row.targetId])
    ).toEqual([['runtime.tool_used', 'echo hi']]);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    await cleanup(() => observed?.return(undefined));
    await cleanup(() => raw?.return(undefined));
    await cleanup(() => runtime?.releaseLock(sessionId, clientId));
    await cleanup(() => scenarioStore.clearSession(sessionId));
    await cleanup(() => resetAuditTrail());
    await cleanup(() => resetRecordedToolCalls());
    await cleanup(() => h?.cleanup());
    await cleanup(() => nativeFs.rm(dir, { recursive: true, force: true }));
    serverEnv.DORKOS_TEST_RUNTIME = prior;
  }
  if (failed) throw first;
});
