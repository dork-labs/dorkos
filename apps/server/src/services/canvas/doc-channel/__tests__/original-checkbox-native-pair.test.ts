/** Genuine installed FILE writer/consumed approval/native Room controls. All original effects remain unmocked. */
import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql, canvasDocuments, eq } from '@dorkos/db';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { toggleOriginalCheckboxWriter } from '../writes/checkbox-service.js';
import { rawByteHash } from '../writes/checkbox-bytes.js';
import { currentRoomDueServicePort, submitCurrentDocEvent } from '../service.js';
import { docDocumentGeneration } from '../identity/incarnation.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  TestModeRuntime,
  captureTestModeOriginalRoomEmitter,
  readTestModeOriginalScenarioCounts,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { env as serverEnv } from '../../../../env.js';

type Fixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;
async function withNativeFile(
  work: (h: Fixture, runtime: TestModeRuntime, registry: RuntimeRegistry) => Promise<void>,
  coalesceWindowMs = 100
) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'actual-original-checkbox-pair-')));
  const sessionId = randomUUID();
  let h: Fixture | undefined,
    failed = false,
    first: unknown,
    drained = false;
  try {
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, randomUUID(), {
      checkboxFile: true,
      coalesceWindowMs,
    });
    // The original constructor alone consumes this test boot flag. Keep its
    // lifetime synchronous so an earlier timed-out case cannot retire this lane.
    const oldMode = serverEnv.DORKOS_TEST_RUNTIME;
    let runtime: TestModeRuntime;
    try {
      serverEnv.DORKOS_TEST_RUNTIME = true;
      runtime = new TestModeRuntime('claude-code', h.principals);
    } finally {
      serverEnv.DORKOS_TEST_RUNTIME = oldMode;
    }
    const registry = new RuntimeRegistry();
    captureTestModeOriginalRoomEmitter(runtime, h.http.fileWrites, h.db, h.http.channels);
    registry.setDb(h.db);
    registry.register(runtime);
    scenarioStore.setForSession(sessionId, 'simple-text');
    expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 0 });
    await work(h, runtime, registry);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      if (h) {
        await h.cleanup();
        drained = true;
      }
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      scenarioStore.clearSession(sessionId);
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (drained)
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
  }
  if (failed) throw first;
}
const tickDue = () => new Promise<void>((resolve) => setTimeout(resolve, 110));
async function freezeOriginalDue(h: Fixture): Promise<void> {
  const batch = h.db.get<{ dueAt: string; status: string }>(sql`SELECT due_at AS dueAt,status
    FROM canvas_doc_batches WHERE document_id=${h.documentId} ORDER BY due_at LIMIT 1`)!;
  expect(batch.status).toBe('pending');
  const remaining = Date.parse(batch.dueAt) - Date.now();
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  currentRoomDueServicePort(h.http.service).wake();
}
function rows(h: Fixture) {
  return h.db.all<Record<string, unknown>>(
    sql`SELECT * FROM canvas_doc_batches WHERE document_id=${h.documentId} ORDER BY batch_id`
  );
}
async function comment(h: Fixture) {
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
    payload: { text: 'retain original unrelated comment' },
  };
  const accepted = await submitCurrentDocEvent(h.http.service, h.documentId, event, h.operator, {
    expectedGeneration: docDocumentGeneration(physical, channel),
  });
  expect(accepted.deliveries).toHaveLength(1);
  expect(accepted.deliveries[0]).toMatchObject({
    routeId: 'native-room',
    status: 'pending',
    reason: null,
  });
  return event;
}
it('cancels the genuine FILE toggle and inverse Undo with both exact receipts, distinct line hashes and zero native scenario entries', async () => {
  await withNativeFile(async (h, runtime, registry) => {
    const baseline = await fs.readFile(h.checkboxPath!);
    const first = await h.checkboxRequest(true),
      changed = await toggleOriginalCheckboxWriter(h.http.checkboxWriter, first, h.operator);
    expect(changed.status).toBe('changed');
    const originalEvent = h.http.channels.getEvent(h.documentId, first.eventId)!;
    expect(rows(h)[0].status).toBe('pending');
    await freezeOriginalDue(h);
    const before = rows(h);
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe('accepted');
    const second = await h.checkboxRequest(false);
    expect(second.textHash).not.toBe(first.textHash);
    const undone = await toggleOriginalCheckboxWriter(h.http.checkboxWriter, second, h.operator);
    expect(undone.status).toBe('changed');
    expect(await fs.readFile(h.checkboxPath!)).toEqual(baseline);
    const secondEvent = h.http.channels.getEvent(h.documentId, second.eventId)!;
    expect(secondEvent.docSeq).toBeGreaterThan(originalEvent.docSeq);
    const after = rows(h);
    expect(after.length).toBeGreaterThan(0);
    expect(
      after.every(
        (row) => row.status === 'cancelled' && row.error_code === 'checkbox_baseline_restored'
      )
    ).toBe(true);
    const retained = after.find((row) => row.batch_id === before[0].batch_id)!;
    for (const key of ['batch_id', 'generation']) expect(retained[key]).toEqual(before[0][key]);
    expect(typeof retained.room_source_json).toBe('string');
    expect(typeof retained.room_source_hash).toBe('string');
    const deliveries = h.db.all<{ event_id: string; status: string }>(
      sql`SELECT event_id,status FROM canvas_doc_deliveries WHERE document_id=${h.documentId}`
    );
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((row) => row.event_id))).toEqual(
      new Set([first.eventId, second.eventId])
    );
    expect(deliveries.every((row) => row.status === 'cancelled')).toBe(true);
    await tickDue();
    const port = currentRoomDueServicePort(h.http.service);
    port.wake();
    await port.pump(registry);
    await port.pump(registry);
    expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 0 });
    expect(rows(h)).toEqual(after);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n).toBe(0);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(0);
    expect(h.http.channels.getEvent(h.documentId, first.eventId)).toEqual(originalEvent);
    expect(h.http.channels.getEvent(h.documentId, second.eventId)).toEqual(secondEvent);
    expect(await toggleOriginalCheckboxWriter(h.http.checkboxWriter, first, h.operator)).toEqual(
      changed
    );
    expect(await toggleOriginalCheckboxWriter(h.http.checkboxWriter, second, h.operator)).toEqual(
      undone
    );
    expect(await fs.readFile(h.checkboxPath!)).toEqual(baseline);
  });
});
it('preserves a real unrelated comment when the physical toggle and Undo share its accepted batch', async () => {
  await withNativeFile(async (h) => {
    const baseline = await fs.readFile(h.checkboxPath!),
      first = await h.checkboxRequest(true);
    expect(
      (await toggleOriginalCheckboxWriter(h.http.checkboxWriter, first, h.operator)).status
    ).toBe('changed');
    const other = await comment(h),
      originalComment = h.http.channels.getEvent(h.documentId, other.id)!;
    expect(rows(h)).toHaveLength(1);
    const second = await h.checkboxRequest(false);
    expect(
      (await toggleOriginalCheckboxWriter(h.http.checkboxWriter, second, h.operator)).status
    ).toBe('changed');
    expect(await fs.readFile(h.checkboxPath!)).toEqual(baseline);
    const pending = rows(h);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
    if (typeof pending[0].input_event_ids !== 'string')
      throw new Error('Original pending input IDs unavailable');
    expect(JSON.parse(pending[0].input_event_ids)).toEqual([
      first.eventId,
      other.id,
      second.eventId,
    ]);
    await freezeOriginalDue(h);
    const batches = rows(h);
    expect(batches.some((row) => row.status === 'accepted')).toBe(true);
    expect(batches.some((row) => row.error_code === 'checkbox_baseline_restored')).toBe(false);
    expect(h.http.channels.getEvent(h.documentId, other.id)).toEqual(originalComment);
    const delivery = h.db.get<{ status: string }>(
      sql`SELECT status FROM canvas_doc_deliveries WHERE event_id=${other.id}`
    )!;
    expect(delivery.status).toBe('pending');
  }, 2000);
});
it('refuses cancellation when a genuine intervening physical edit makes Undo noninverse', async () => {
  await withNativeFile(async (h) => {
    const baseline = await fs.readFile(h.checkboxPath!),
      first = await h.checkboxRequest(true);
    expect(
      (await toggleOriginalCheckboxWriter(h.http.checkboxWriter, first, h.operator)).status
    ).toBe('changed');
    await fs.appendFile(h.checkboxPath!, 'actual retained second line\n');
    const second = await h.checkboxRequest(false);
    expect(
      (await toggleOriginalCheckboxWriter(h.http.checkboxWriter, second, h.operator)).status
    ).toBe('changed');
    expect(rawByteHash(await fs.readFile(h.checkboxPath!))).not.toBe(rawByteHash(baseline));
    expect(rows(h).some((row) => row.error_code === 'checkbox_baseline_restored')).toBe(false);
  });
});
it('preserves original native COMMIT/FIRST and spend when Undo arrives after the genuine first scenario', async () => {
  await withNativeFile(async (h, runtime, registry) => {
    const baseline = await fs.readFile(h.checkboxPath!),
      first = await h.checkboxRequest(true);
    expect(
      (await toggleOriginalCheckboxWriter(h.http.checkboxWriter, first, h.operator)).status
    ).toBe('changed');
    await tickDue();
    const port = currentRoomDueServicePort(h.http.service);
    port.wake();
    await port.pump(registry);
    expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 1 });
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
    const committed = rows(h)[0];
    expect(committed.status).toBe('turn_done');
    const second = await h.checkboxRequest(false);
    expect(
      (await toggleOriginalCheckboxWriter(h.http.checkboxWriter, second, h.operator)).status
    ).toBe('changed');
    expect(await fs.readFile(h.checkboxPath!)).toEqual(baseline);
    const after = rows(h);
    expect(after.find((row) => row.batch_id === committed.batch_id)).toEqual(committed);
    expect(after.some((row) => row.error_code === 'checkbox_baseline_restored')).toBe(false);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
  });
});

it('consumes genuine FILE approval through the final private check despite reflected prepare/getGrant replacements', async () => {
  await withNativeFile(async (h) => {
    const prepare = h.http.grants.prepare,
      getGrant = h.http.channels.getGrant;
    let reflected = 0;
    h.http.grants.prepare = () => {
      reflected++;
      throw new Error('Reflected prepare reached.');
    };
    h.http.channels.getGrant = () => {
      reflected++;
      throw new Error('Reflected grant lookup reached.');
    };
    try {
      if (h.granted.kind !== 'granted') throw new Error('Actual initial grant missing.');
      h.http.grants.revoke(h.documentId, h.granted.grant.grantId, h.operator);
      const request = {
        documentId: h.documentId,
        routeId: 'native-room',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const pending = await h.http.grantCheckboxRoute(request, h.operator);
      expect(pending.kind).toBe('approval_required');
      if (pending.kind !== 'approval_required') throw new Error('Actual approval missing.');
      h.approvals.grant(pending.ticket.approvalId);
      const consumed = await h.http.grantCheckboxRoute(request, h.operator, pending.ticket.token);
      expect(consumed.kind).toBe('granted');
      expect(reflected).toBe(0);
      if (consumed.kind !== 'granted') throw new Error('Actual final FILE grant missing.');
      expect(consumed.grant.writeOperation).toMatchObject({ operation: 'checkbox-toggle' });
    } finally {
      h.http.grants.prepare = prepare;
      h.http.channels.getGrant = getGrant;
    }
  });
});
