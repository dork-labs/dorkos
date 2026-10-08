import { addAcceptedReceiptPage } from './accepted-page-fixtures.js';
/** Real file SQLite evidence for accepted, unclaimed document waiting warnings. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  eq,
  asc,
  canvasDocChannels,
  canvasDocBatches,
  canvasDocEvents,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  sessionStagedContext,
  type Db,
} from '@dorkos/db';
import { batchFixture, NOW, FROM, TO, type BatchFixture } from './batch-fixtures.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';
import { StagedContextStore } from '../../../session/staged-context-store.js';
import { DocChannelIngest } from '../ingest.js';
const databases: Db[] = [];
const directories: string[] = [];
// Join this page fixture's original initializer/action before deleting owned resources.
const paginationOperations: Promise<unknown>[] = [];
afterEach(async () => {
  await Promise.allSettled(paginationOperations.splice(0));
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const MINUTE = 60000;
function warnings(f: BatchFixture) {
  return f.db
    .select()
    .from(canvasDocEvents)
    .all()
    .filter(
      (row) =>
        row.type === 'event.status' &&
        typeof (row.payload as { warning?: unknown }).warning === 'string'
    );
}
function snapshot(f: BatchFixture, batchId: string) {
  const { waitingWarningAt: _marker, ...batch } = f.store.getBatch(batchId)!;
  return {
    batch,
    receipts: f.db.select().from(sessionMessageAcceptanceReceipts).all(),
    queue: f.db.select().from(sessionMessageQueue).all(),
    staged: f.db.select().from(sessionStagedContext).all(),
    inputs: f.db
      .select()
      .from(canvasDocEvents)
      .all()
      .filter((row) => row.direction === 'upstream'),
  };
}
async function setup(defer = true) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-accepted-warning-'));
  directories.push(dir);
  const file = join(dir, 'state.db');
  let time = Date.parse(NOW);
  const now = () => new Date(time);
  const deadline = new Date(time + 60 * MINUTE).toISOString();
  const gate = () =>
    defer
      ? {
          decision: 'defer' as const,
          reason: 'route_turn_ceiling',
          nextEligibleAt: deadline,
        }
      : { decision: 'admit' as const };
  let f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', now, gate);
  databases.push(f.db);
  f.input({ text: 'Unicode 🦉 still waiting' });
  const accepted = f.admission.admit(f.batchId());
  new StagedContextStore(f.db).hold('session-1', 'Keep this staged note', 'staged-warning');
  const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
  if (defer)
    expect(f.admission.acceptance.claim(accepted.receipt.id, prepared)).toMatchObject({
      deferred: true,
      nextEligibleAt: deadline,
    });
  const nudge = vi.fn(() => undefined);
  const pump = (fixture = f) =>
    new DocBatchDeliveryPump({
      db: fixture.db,
      store: fixture.store,
      grants: fixture.grants,
      admission: fixture.admission,
      now,
      capacity: () => ({ available: true }),
      budget: () => ({ available: true }),
      markWaitingWarning: (id, g, at, tx) => fixture.store.markWaitingWarning(id, g, at, tx),
      nudge,
    });
  const pass = async () => {
    await pump().resumeAcceptedPage();
    return pump().run();
  };
  return {
    get f() {
      return f;
    },
    file,
    now,
    deadline,
    accepted,
    prepared,
    nudge,
    pump,
    pass,
    at: (ms: number) => {
      time = Date.parse(NOW) + ms;
    },
    reopen: () => {
      f.db.$client.close();
      const db = createDb(file);
      databases.push(db);
      f = batchFixture(
        file,
        null,
        { db, documentId: f.documentId, grantId: f.grantId },
        'boot-2',
        'claude-code',
        now,
        gate
      );
      return f;
    },
  };
}
it('warns at exactly fifteen minutes independently of a one-hour dispatch lease without early adoption or evidence mutation', async () => {
  const h = await setup();
  const before = snapshot(h.f, h.accepted.receipt.sourceId);
  h.at(15 * MINUTE - 1);
  await h.pass();
  expect(warnings(h.f)).toEqual([]);
  expect(h.nudge).not.toHaveBeenCalled();
  h.at(15 * MINUTE);
  await h.pass();
  expect(snapshot(h.f, h.accepted.receipt.sourceId)).toEqual(before);
  expect(h.nudge).not.toHaveBeenCalled();
  expect(warnings(h.f)).toHaveLength(1);
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.waitingWarningAt).toBe(
    h.now().toISOString()
  );
  await h.pass();
  expect(warnings(h.f)).toHaveLength(1);
});
it('rolls back the marker if durable warning append fails and retries the same generation once', async () => {
  const h = await setup();
  h.at(15 * MINUTE);
  const before = snapshot(h.f, h.accepted.receipt.sourceId);
  const original = h.f.store.appendEvent.bind(h.f.store);
  let attempts = 0;
  const spy = vi.spyOn(h.f.store, 'appendEvent').mockImplementation((input, tx) => {
    if (input.type === 'event.status' && (input.payload as { warning?: unknown }).warning) {
      attempts++;
      throw new Error('warning append unavailable');
    }
    return original(input, tx);
  });
  try {
    await h.pass();
  } catch {
    /* An observable append failure must never partially persist. */
  }
  expect(snapshot(h.f, h.accepted.receipt.sourceId)).toEqual(before);
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.waitingWarningAt).toBeNull();
  expect(warnings(h.f)).toEqual([]);
  expect(attempts).toBe(1);
  spy.mockRestore();
  await h.pass();
  expect(warnings(h.f)).toHaveLength(1);
});
it('canonical rekey and file restart preserve the original accepted identity and exactly one warning', async () => {
  const h = await setup();
  expect(h.f.documents.rekeyScope(FROM, TO)).toBe(1);
  const moved = snapshot(h.f, h.accepted.receipt.sourceId);
  h.reopen();
  h.at(15 * MINUTE);
  await h.pass();
  expect(snapshot(h.f, h.accepted.receipt.sourceId)).toEqual(moved);
  expect(warnings(h.f)).toHaveLength(1);
  h.reopen();
  await h.pass();
  expect(warnings(h.f)).toHaveLength(1);
  expect(h.nudge).not.toHaveBeenCalled();
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.scope).toBe(TO);
});
it('two actual file connection owners cannot append two warnings for one accepted generation', async () => {
  const h = await setup();
  const db = createDb(h.file);
  databases.push(db);
  const second = batchFixture(
    h.file,
    null,
    { db, documentId: h.f.documentId, grantId: h.f.grantId },
    'boot-1',
    'claude-code',
    h.now,
    () => ({
      decision: 'defer',
      reason: 'route_turn_ceiling',
      nextEligibleAt: h.deadline,
    })
  );
  h.at(15 * MINUTE);
  await Promise.all([h.pass(), Promise.resolve().then(() => h.pump(second).run())]);
  expect(warnings(h.f)).toHaveLength(1);
  expect(h.nudge).not.toHaveBeenCalled();
});
it('does not expire an accepted unclaimed wait after twenty-four hours', async () => {
  const h = await setup();
  h.at(24 * 60 * MINUTE + 1);
  const result = h.pump().run();
  expect(result.expired).toBe(0);
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.status).toBe('accepted');
  expect(h.f.queue.get(h.accepted.receipt.queueMessageId)).toBeDefined();
  expect(
    warnings(h.f).filter((row) => (row.payload as { status?: string }).status === 'expired')
  ).toEqual([]);
});
it.each(['claimed', 'started', 'terminal', 'revoked'] as const)(
  'never warns when current receipt authority is %s',
  async (state) => {
    const h = await setup(state === 'revoked');
    if (state === 'revoked') h.f.grants.revoke(h.f.documentId, h.f.grantId, h.f.actor);
    else {
      expect(h.f.admission.acceptance.claim(h.accepted.receipt.id, h.prepared)).toMatchObject({
        receiptId: h.accepted.receipt.id,
      });
      if (state !== 'claimed') h.f.admission.acceptance.markTurnStarted(h.accepted.receipt.id, 3);
      if (state === 'terminal') h.f.admission.acceptance.settle(h.accepted.receipt.id, 'ok');
    }
    h.at(15 * MINUTE);
    await h.pass();
    expect(warnings(h.f)).toEqual([]);
    expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.waitingWarningAt).toBeNull();
    expect(h.nudge).not.toHaveBeenCalled();
  }
);

function addAccepted(h: Awaited<ReturnType<typeof setup>>, index: number) {
  const f = h.f;
  const doc = f.canvas.open(FROM, 'agent-1', {
    type: 'markdown',
    title: `Warning ${index}`,
    content: `Body ${index}`,
  });
  f.canvas.pin(FROM, doc.id, true);
  f.db
    .update(canvasDocChannels)
    .set({ openerAgentId: 'agent-1' })
    .where(eq(canvasDocChannels.documentId, doc.id))
    .run();
  f.grants.configure(
    doc.id,
    {
      routes: [
        {
          id: 'route',
          on: 'task.*',
          to: 'agent:owner',
          turn: { mode: 'immediate', maxBatch: 100 },
        },
      ],
    },
    f.actor
  );
  f.grants.grant(
    {
      documentId: doc.id,
      routeId: 'route',
      expiresAt: '2026-10-02T00:00:00.000Z',
    },
    f.actor
  );
  const input = new DocChannelIngest(f.store, () => new Date(NOW)).accept(
    { v: 1, id: randomUUID(), type: 'task.changed', payload: { index } },
    (tx) => ({
      documentId: doc.id,
      scope: FROM,
      documentLabel: doc.title,
      provenance: {},
      routes: f.grants.getCurrentRoutes(doc.id, 'task.changed', f.actor, tx),
    })
  );
  const accepted = f.admission.admit(input.deliveries[0]!.batchId!);
  return accepted.receipt;
}
async function deferAccepted(h: Awaited<ReturnType<typeof setup>>, receiptId: string) {
  const prepared = await h.f.admission.acceptance.prepare(receiptId);
  expect(h.f.admission.acceptance.claim(receiptId, prepared)).toMatchObject({
    deferred: true,
  });
}
async function addWaiting(h: Awaited<ReturnType<typeof setup>>, index: number) {
  const receipt = addAccepted(h, index);
  await deferAccepted(h, receipt.id);
  return receipt;
}
describe('accepted wait warning page fixture', () => {
  let pageFixture!: {
    h: Awaited<ReturnType<typeof setup>>;
    evidence: (typeof sessionMessageAcceptanceReceipts.$inferSelect)[];
  };
  beforeEach(async () => {
    const initializing = (async () => {
      const h = await setup();
      h.f.canvas.pin(FROM, h.f.documentId, true);
      // Populate actual accepted/routed busy waits; the original row still proves the
      // one-hour final-budget hold. Warning pagination does not need 104 extra
      // final-budget claim/deferral cycles before exercising its actual authority checks.
      addAcceptedReceiptPage(h.f, 104);
      const evidence = h.f.db.select().from(sessionMessageAcceptanceReceipts).all();
      return { h, evidence };
    })();
    paginationOperations.push(initializing);
    pageFixture = await initializing;
  });

  it('pages more than 100 same-session accepted waits without adopting them and wraps new earlier keys', async () => {
    const running = (async () => {
      const { h, evidence } = pageFixture;
      expect(evidence).toHaveLength(105);
      expect(new Set(evidence.map((row) => row.id)).size).toBe(105);
      expect(new Set(evidence.map((row) => row.sourceId)).size).toBe(105);
      expect(
        new Set(
          h.f.db
            .select()
            .from(canvasDocBatches)
            .all()
            .map((row) => row.grantId)
        ).size
      ).toBe(105);
      h.at(15 * MINUTE);
      const prepare = vi.spyOn(h.f.admission.acceptance, 'prepare');
      const first = await h.pump().inspectAcceptedWaitWarnings();
      expect(first).toMatchObject({
        selected: 100,
        warned: 100,
        hasMore: true,
        retryableFailures: 0,
      });
      expect(prepare).toHaveBeenCalledTimes(100);
      const second = await h.pump().inspectAcceptedWaitWarnings(first.cursor);
      expect(second).toMatchObject({
        selected: 5,
        warned: 5,
        hasMore: false,
        nextEligibleAt: null,
      });
      expect(prepare).toHaveBeenCalledTimes(105);
      expect(warnings(h.f)).toHaveLength(105);
      const inserted = await addWaiting(h, 999);
      const wrap = await h.pump().inspectAcceptedWaitWarnings();
      expect(wrap).toMatchObject({ selected: 1, warned: 1, hasMore: false });
      expect(h.f.store.getBatch(inserted.sourceId)?.leaseUntil).toBe(h.deadline);
      expect(
        h.f.db
          .select()
          .from(sessionMessageAcceptanceReceipts)
          .all()
          .filter((row) => row.id !== inserted.id)
      ).toEqual(evidence);
      expect(h.nudge).not.toHaveBeenCalled();
    })();
    paginationOperations.push(running);
    await running;
  });
});
it('returns the coalescing warning deadline rather than the one-hour dispatch deadline', async () => {
  const h = await setup();
  const before = snapshot(h.f, h.accepted.receipt.sourceId);
  const page = await h.pump().inspectAcceptedWaitWarnings();
  expect(page).toMatchObject({
    selected: 1,
    warned: 0,
    nextEligibleAt: new Date(Date.parse(NOW) + 15 * MINUTE).toISOString(),
  });
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.dueAt).toBe(
    new Date(Date.parse(NOW) + 1000).toISOString()
  );
  expect(snapshot(h.f, h.accepted.receipt.sourceId)).toEqual(before);
  expect(h.nudge).not.toHaveBeenCalled();
});
it('continues after first and middle transient prepare failures, then wraps to retry without duplicate warnings', async () => {
  const h = await setup();
  h.f.canvas.pin(FROM, h.f.documentId, true);
  for (let i = 0; i < 4; i++) await addWaiting(h, i);
  const order = h.f.db
    .select()
    .from(canvasDocBatches)
    .orderBy(asc(canvasDocBatches.dueAt), asc(canvasDocBatches.batchId))
    .all();
  const failed = new Set([order[0]!.admissionReceiptId!, order[2]!.admissionReceiptId!]);
  const original = h.f.admission.acceptance.prepare.bind(h.f.admission.acceptance);
  const spy = vi.spyOn(h.f.admission.acceptance, 'prepare').mockImplementation(async (id) => {
    if (failed.has(id)) throw new Error('storage temporarily unavailable');
    return original(id);
  });
  h.at(15 * MINUTE);
  const first = await h.pump().inspectAcceptedWaitWarnings();
  expect(first).toMatchObject({
    selected: 5,
    warned: 3,
    retryableFailures: 2,
    hasMore: false,
    nextEligibleAt: new Date(h.now().getTime() + MINUTE).toISOString(),
  });
  for (const row of order)
    expect(h.f.store.getBatch(row.batchId)?.waitingWarningAt).toBe(
      failed.has(row.admissionReceiptId!) ? null : h.now().toISOString()
    );
  spy.mockRestore();
  const retry = await h.pump().inspectAcceptedWaitWarnings();
  expect(retry).toMatchObject({ selected: 2, warned: 2, retryableFailures: 0 });
  expect(warnings(h.f)).toHaveLength(5);
  expect(h.nudge).not.toHaveBeenCalled();
});
it('stopping during held preparation prevents marker and status mutation after the await', async () => {
  const h = await setup();
  h.at(15 * MINUTE);
  const before = snapshot(h.f, h.accepted.receipt.sourceId);
  let active = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.f.admission.acceptance.prepare.bind(h.f.admission.acceptance);
  vi.spyOn(h.f.admission.acceptance, 'prepare').mockImplementation(async (id) => {
    await held;
    return original(id);
  });
  const pass = h.pump().inspectAcceptedWaitWarnings(undefined, 100, () => active);
  await Promise.resolve();
  active = false;
  release();
  expect((await pass).warned).toBe(0);
  expect(snapshot(h.f, h.accepted.receipt.sourceId)).toEqual(before);
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.waitingWarningAt).toBeNull();
  expect(warnings(h.f)).toEqual([]);
  expect(h.nudge).not.toHaveBeenCalled();
});

it('a warning inspection failure preserves progress through the independent accepted recovery lane', async () => {
  const h = await setup(false);
  const pump = h.pump();
  vi.spyOn(pump, 'inspectAcceptedWaitWarnings').mockRejectedValueOnce(
    new Error('warning storage unavailable')
  );
  const page = await pump.resumeAcceptedPage();
  expect(page.retryableFailures).toBe(1);
  expect(page.notifications.get(h.accepted.receipt.sessionId)).toEqual([h.accepted.receipt.id]);
  expect(h.nudge).toHaveBeenCalledExactlyOnceWith(h.accepted.receipt.sessionId, [
    h.accepted.receipt.id,
  ]);
  expect(warnings(h.f)).toEqual([]);
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.waitingWarningAt).toBeNull();
});

it.each([
  "UPDATE agents SET status='inactive' WHERE id='agent-1'",
  "UPDATE agents SET project_path='/changed' WHERE id='agent-1'",
  "UPDATE session_metadata SET runtime='codex' WHERE session_id='session-1'",
  "UPDATE session_metadata SET agent_path='/changed' WHERE session_id='session-1'",
  "UPDATE canvas_documents SET scope='session:changed'",
  "UPDATE canvas_doc_grants SET revoked_at='2026-10-01T00:00:00.000Z'",
])('parameterized readers see current authority after preparation: %s', async (mutation) => {
  const h = await setup();
  h.at(15 * MINUTE);
  const before = snapshot(h.f, h.accepted.receipt.sourceId);
  const original = h.f.admission.acceptance.prepare.bind(h.f.admission.acceptance);
  vi.spyOn(h.f.admission.acceptance, 'prepare').mockImplementation(async (id) => {
    const prepared = await original(id);
    h.f.db.$client.prepare(mutation).run();
    return prepared;
  });
  const page = await h.pump().inspectAcceptedWaitWarnings();
  expect(page).toMatchObject({
    selected: 1,
    warned: 0,
    retryableFailures: 1,
  });
  expect(snapshot(h.f, h.accepted.receipt.sourceId)).toEqual(before);
  expect(h.f.store.getBatch(h.accepted.receipt.sourceId)?.waitingWarningAt).toBeNull();
  expect(warnings(h.f)).toEqual([]);
  expect(h.nudge).not.toHaveBeenCalled();
});
