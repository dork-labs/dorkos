/** Consumer acceptance over the installed FILE writer and real Room persistence; paid runtimes remain unarmed. */
import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from '@dorkos/db';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { toggleOriginalCheckboxWriter } from '../writes/checkbox-service.js';
import { currentRoomDueServicePort } from '../service.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  TestModeRuntime,
  captureTestModeOriginalRoomEmitter,
  readTestModeOriginalScenarioCounts,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { env as serverEnv } from '../../../../env.js';

type Fixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;
async function owned(
  work: (
    h: Fixture,
    runtime: TestModeRuntime,
    registry: RuntimeRegistry,
    sessionId: string
  ) => Promise<void>
) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-checkbox-consumer-')));
  const sessionId = randomUUID(),
    oldMode = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Fixture | undefined,
    failed = false,
    first: unknown,
    drained = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, randomUUID(), {
      checkboxFile: true,
      coalesceWindowMs: 100,
    });
    const runtime = new TestModeRuntime('claude-code', h.principals),
      registry = new RuntimeRegistry();
    captureTestModeOriginalRoomEmitter(runtime, h.http.fileWrites, h.db, h.http.channels);
    registry.setDb(h.db);
    registry.register(runtime);
    scenarioStore.setForSession(sessionId, 'simple-text');
    await work(h, runtime, registry, sessionId);
  } catch (cause) {
    remember(cause);
  } finally {
    try {
      if (h) {
        await h.cleanup();
        drained = true;
      }
    } catch (cause) {
      remember(cause);
    }
    try {
      scenarioStore.clearSession(sessionId);
    } catch (cause) {
      remember(cause);
    }
    if (drained)
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
    serverEnv.DORKOS_TEST_RUNTIME = oldMode;
  }
  if (failed) throw first;
}
function batches(h: Fixture) {
  return h.db.all<Record<string, unknown>>(
    sql`SELECT * FROM canvas_doc_batches WHERE document_id=${h.documentId} ORDER BY batch_id`
  );
}

it('saved native checkbox receipt survives busy admission and identical retry; one completion does not fabricate app acknowledgement', async () => {
  await owned(async (h, runtime, registry, sessionId) => {
    const lockId = 'original-consumer-busy';
    const holder = { on: () => {} };
    expect(runtime.acquireLock(sessionId, lockId, holder)).toBe(true);
    let locked = true;
    try {
      const request = await h.checkboxRequest(true);
      const saved = await toggleOriginalCheckboxWriter(h.http.checkboxWriter, request, h.operator);
      expect(saved.status).toBe('changed');
      expect((await fs.readFile(h.checkboxPath!, 'utf8')).startsWith('- [x]')).toBe(true);
      const event = h.http.channels.getEvent(h.documentId, request.eventId)!;
      expect(event.type).toBe('md.task.toggled');
      const original = batches(h);
      expect(original).toHaveLength(1);
      const port = currentRoomDueServicePort(h.http.service);
      await new Promise<void>((resolve) => setTimeout(resolve, 110));
      port.wake();
      await port.pump(registry);
      expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 0 });
      const waiting = batches(h);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]!.batch_id).toBe(original[0]!.batch_id);
      expect(waiting[0]!.generation).toBe(original[0]!.generation);
      expect(
        await toggleOriginalCheckboxWriter(h.http.checkboxWriter, request, h.operator)
      ).toEqual(saved);
      expect(h.http.channels.getEvent(h.documentId, request.eventId)).toEqual(event);
      expect(
        h.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM canvas_doc_write_intents WHERE document_id=${h.documentId}`
        )!.n
      ).toBe(1);
      expect(h.http.channels.listDeliveries(h.documentId, request.eventId)).toHaveLength(1);
      runtime.releaseLock(sessionId, lockId);
      locked = false;
      port.wake();
      await port.pump(registry);
      await port.pump(registry);
      expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 1 });
      expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n).toBe(
        1
      );
      expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
      const completed = batches(h);
      expect(completed).toHaveLength(1);
      expect(completed[0]!).toMatchObject({
        batch_id: original[0]!.batch_id,
        generation: original[0]!.generation,
        status: 'turn_done',
      });
      const deliveries = h.http.channels.listDeliveries(h.documentId, request.eventId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe('turn_done');
      expect(deliveries[0]!.ackOutcome).toBeNull();
      expect(
        await toggleOriginalCheckboxWriter(h.http.checkboxWriter, request, h.operator)
      ).toEqual(saved);
      port.wake();
      await port.pump(registry);
      expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 1 });
      expect(h.http.channels.getEvent(h.documentId, request.eventId)).toEqual(event);
    } finally {
      if (locked) runtime.releaseLock(sessionId, lockId);
    }
  });
});

it('mismatched document and revoked native write grant refuse before any FILE mutation or recorded input', async () => {
  await owned(async (h) => {
    const baseline = await fs.readFile(h.checkboxPath!);
    const request = await h.checkboxRequest(true);
    await expect(
      toggleOriginalCheckboxWriter(
        h.http.checkboxWriter,
        { ...request, documentId: randomUUID() },
        h.operator
      )
    ).rejects.toThrow();
    h.http.grants.revoke(h.documentId, h.granted.grant.grantId, h.operator);
    await expect(
      toggleOriginalCheckboxWriter(h.http.checkboxWriter, request, h.operator)
    ).rejects.toThrow();
    expect(await fs.readFile(h.checkboxPath!)).toEqual(baseline);
    expect(h.http.channels.getEvent(h.documentId, request.eventId)).toBeUndefined();
    expect(batches(h)).toHaveLength(0);
    expect(
      h.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM canvas_doc_write_intents WHERE document_id=${h.documentId}`
      )!.n
    ).toBe(0);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n).toBe(0);
  });
});
