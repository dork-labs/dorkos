/** Retention keeps bounded query work over real migrated, fully accounted history. */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDb, runMigrations, sql } from '@dorkos/db';
import { DocChannelStore } from '../store.js';
import { retainDocHistory } from '../retention.js';
import { publicCurrentDelivery } from '../current/current-operation-intentions.js';
import { currentRoomDueServicePort, replayServiceCurrentDoc } from '../service.js';

it('totals completed history once and uses indexed accounting and oldest-first scans', () => {
  const db = createDb(':memory:');
  try {
    runMigrations(db);
    const store = new DocChannelStore(db);
    const now = '2026-10-01T12:00:00.000Z';
    store.initialize({
      documentId: 'history',
      scope: 'session:history',
      createdAt: now,
      updatedAt: now,
    });
    const insert = db.$client.prepare(`INSERT INTO canvas_doc_events
      (document_id,event_id,doc_seq,direction,type,payload,envelope_hash,envelope_bytes,received_at,provenance)
      VALUES ('history',?,?,'upstream','task.comment',?, ?,256,?,'{}')`);
    db.$client.transaction(() => {
      for (let seq = 1; seq <= 1000; seq++)
        insert.run(
          randomUUID(),
          seq,
          JSON.stringify({ text: 'fresh history' }),
          'a'.repeat(64),
          now
        );
    })();
    const prepare = vi.spyOn(db.$client, 'prepare');
    const started = performance.now();
    retainDocHistory(store, now);
    const elapsed = performance.now() - started;
    const totals = prepare.mock.calls.filter(([query]) =>
      /SELECT\s+(?:coalesce\(sum|e\.document_id AS documentId,sum)/u.test(query)
    );
    expect(totals.length).toBeLessThanOrEqual(2);
    prepare.mockRestore();
    expect(
      db.$client
        .prepare('SELECT count(*) AS count FROM canvas_doc_events WHERE payload_pruned_at IS NULL')
        .get()
    ).toEqual({ count: 1000 });
    const accountingPlan = db.$client
      .prepare(
        `EXPLAIN QUERY PLAN SELECT document_id,event_id
      FROM canvas_doc_events WHERE envelope_bytes=0 AND payload_pruned_at IS NULL LIMIT 200`
      )
      .all() as { detail: string }[];
    expect(
      accountingPlan.some((row) => row.detail.includes('canvas_doc_events_unaccounted_idx'))
    ).toBe(true);
    const retentionPlan = db.$client
      .prepare(
        `EXPLAIN QUERY PLAN SELECT document_id,event_id,doc_seq
      FROM canvas_doc_events WHERE (received_at,document_id,doc_seq)>(?, ?, ?)
      ORDER BY received_at,document_id,doc_seq LIMIT 200`
      )
      .all(now, 'history', 0) as { detail: string }[];
    expect(
      retentionPlan.some((row) => row.detail.includes('canvas_doc_events_retention_idx'))
    ).toBe(true);
    expect(retentionPlan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);
    // Evidence only: wall-clock thresholds would be flaky on shared CI runners.
    console.info(
      `Fresh 1000-row retention: ${elapsed.toFixed(1)} ms, ${totals.length} aggregate queries`
    );
  } finally {
    vi.restoreAllMocks();
    db.$client.close();
  }
});

// The paid SDK process alone is replaced. Authority comes from the real original constructor/FILE DB.
const nativeRetentionSdk = vi.hoisted(() => ({
  options: [] as unknown[],
  prompts: [] as unknown[],
  parked: true,
  held: false,
  release: undefined as (() => void) | undefined,
}));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      nativeRetentionSdk.options.push(options);
    }
    startThread() {
      return {
        id: 'native-retention-source',
        runStreamed: async (prompt: unknown, options?: { signal?: AbortSignal }) => {
          nativeRetentionSdk.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'native-retention-source' };
              if (nativeRetentionSdk.parked)
                await new Promise<void>((resolve, reject) => {
                  const signal = options?.signal;
                  const abort = () => {
                    nativeRetentionSdk.held = false;
                    signal?.removeEventListener('abort', abort);
                    reject(signal?.reason);
                  };
                  const release = () => {
                    nativeRetentionSdk.held = false;
                    signal?.removeEventListener('abort', abort);
                    resolve();
                  };
                  nativeRetentionSdk.held = true;
                  nativeRetentionSdk.release = release;
                  signal?.addEventListener('abort', abort, { once: true });
                  if (signal?.aborted) abort();
                });
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
              };
            })(),
          };
        },
      };
    }
    resumeThread() {
      return this.startThread();
    }
  },
}));
import {
  nativeCommittedCodexRoomFixture,
  reopenNativeRoomAuthorityFixture,
} from '../writes/__tests__/authority-fixtures.js';
function originalNativeRetentionSource(
  disposition: 'settled' | 'acknowledged' | 'unpulled' | 'claimed' = 'settled'
) {
  nativeRetentionSdk.options.length = 0;
  nativeRetentionSdk.prompts.length = 0;
  nativeRetentionSdk.parked = true;
  nativeRetentionSdk.held = false;
  nativeRetentionSdk.release = undefined;
  return nativeCommittedCodexRoomFixture(
    {
      options: nativeRetentionSdk.options,
      prompts: nativeRetentionSdk.prompts,
      releaseProducer: () => nativeRetentionSdk.release?.(),
      completeFutureTurns: () => {
        nativeRetentionSdk.parked = false;
      },
      holdFutureTurns: () => {
        nativeRetentionSdk.parked = true;
      },
      isProducerHeld: () => nativeRetentionSdk.held,
    },
    disposition
  );
}

it.each(['settled', 'unpulled'] as const)(
  'keeps real %s native links and floors while pruning an unrelated later event',
  async (disposition) => {
    const h = await originalNativeRetentionSource(disposition);
    let failed = false,
      first: unknown;
    try {
      const store = h.http.channels;
      const before = store.getEvent(h.documentId, h.input.id)!;
      const deliveries = store.listDeliveries(h.documentId, h.input.id);
      const batch = store.getBatch(deliveries[0]!.batchId!)!;
      const unrelatedId = randomUUID();
      const unrelated = store.appendEvent({
        documentId: h.documentId,
        eventId: unrelatedId,
        direction: 'upstream',
        type: 'md.comment',
        payload: { text: 'removable later ordinary event' },
        envelopeHash: 'a'.repeat(64),
        envelopeBytes: 64,
        receivedAt: before.receivedAt,
        provenance: {},
      });
      retainDocHistory(store, new Date(Date.parse(before.receivedAt) + 86400_000).toISOString(), {
        ageMs: 1,
        documentBytes: 1,
        installationBytes: 1,
      });
      expect(store.getEvent(h.documentId, h.input.id)).toEqual(before);
      expect(store.listDeliveries(h.documentId, h.input.id)).toEqual(deliveries);
      expect(store.getBatch(batch.batchId)).toEqual(batch);
      expect(store.getEvent(h.documentId, unrelatedId)).toBeUndefined();
      expect(store.getChannel(h.documentId)!.retentionFloor).toBe(unrelated.docSeq + 1);
      expect(store.getChannel(h.documentId)!.receiptRetentionFloor).toBe(unrelated.docSeq + 1);
      const replay = await replayServiceCurrentDoc(h.http.service, h.documentId, h.operator);
      expect(replay.resetRequired).toBe(true);
      expect(replay.receipts.find((receipt) => receipt.receipt.id === h.input.id)).toEqual({
        receipt: { id: h.input.id, status: 'recorded', docSeq: before.docSeq },
        payloadAvailable: true,
        deliveries: deliveries.map(publicCurrentDelivery),
      });
      expect(
        h.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM room_doc_admission_inputs WHERE admission_id=${h.admission.admission_id}`
        )
      ).toEqual({ n: 1 });
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
  }
);

it.each(['acknowledged', 'settled', 'unpulled'] as const)(
  'runs the actual maintenance caller and prunes only an aged %s original admission',
  async (disposition) => {
    const h = await originalNativeRetentionSource(disposition);
    let failed = false;
    let primary: unknown;
    try {
      const spends = h.db.$client.prepare('SELECT * FROM room_turn_spend ORDER BY id').all();
      const batchBefore = h.http.channels.getBatch(
        h.http.channels.listDeliveries(h.documentId, h.input.id)[0]!.batchId!
      )!;
      const receiptBefore = h.http.channels.getEvent(h.documentId, h.input.id)!;
      const issued = h.db.$client
        .prepare('SELECT claimed_at_ms FROM room_doc_admissions WHERE admission_id=?')
        .get(h.admission.admission_id) as { claimed_at_ms: number };
      expect(Number.isSafeInteger(issued.claimed_at_ms)).toBe(true);
      const agedAtMs = issued.claimed_at_ms - 31 * 86400_000;
      const agedAt = new Date(agedAtMs).toISOString();
      // Age only the genuine already-issued receipt; keep the CHECK's own JSON witness in sync.
      // No admission/SDK/source authority is manufactured by this eligibility perturbation.
      h.db.$client
        .prepare(
          `UPDATE room_doc_admissions
        SET claimed_at_ms=?, updated_at=?,
          row_json=json_set(row_json,'$.claimedAtMs',?,'$.updatedAt',?)
        WHERE admission_id=?`
        )
        .run(agedAtMs, agedAt, agedAtMs, agedAt, h.admission.admission_id);
      const aged = h.db.$client
        .prepare('SELECT * FROM room_doc_admissions WHERE admission_id=?')
        .get(h.admission.admission_id);
      expect(aged).toBeDefined();
      const port = currentRoomDueServicePort(h.http.service);
      port.maintain();
      const after = h.db.$client
        .prepare('SELECT * FROM room_doc_admissions WHERE admission_id=?')
        .get(h.admission.admission_id);
      const inputs = h.db.$client
        .prepare('SELECT count(*) AS n FROM room_doc_admission_inputs WHERE admission_id=?')
        .get(h.admission.admission_id);
      if (disposition === 'acknowledged') {
        expect(after).toBeUndefined();
        expect(inputs).toEqual({ n: 0 });
        expect(
          h.db.$client
            .prepare(
              'SELECT room_spend_floor_ms AS floor FROM canvas_doc_channels WHERE document_id=?'
            )
            .get(h.documentId)
        ).toEqual({ floor: expect.any(Number) });
        const floor = h.db.$client
          .prepare(
            'SELECT room_spend_floor_ms AS floor FROM canvas_doc_channels WHERE document_id=?'
          )
          .get(h.documentId) as { floor: number };
        expect(floor.floor).toBeGreaterThan(agedAtMs);
      } else {
        expect(after).toEqual(aged);
        expect(inputs).toEqual({ n: 1 });
        expect(h.http.channels.getBatch(batchBefore.batchId)).toEqual(batchBefore);
        expect(h.http.channels.getEvent(h.documentId, h.input.id)).toEqual(receiptBefore);
        expect(h.http.channels.getChannel(h.documentId)!.retentionFloor).toBeLessThanOrEqual(
          receiptBefore.docSeq
        );
        expect(h.http.channels.getChannel(h.documentId)!.receiptRetentionFloor).toBeLessThanOrEqual(
          receiptBefore.docSeq
        );
      }
      expect(h.db.$client.prepare('SELECT * FROM room_turn_spend ORDER BY id').all()).toEqual(
        spends
      );
      expect(h.db.$client.inTransaction).toBe(false);
      // A second real pass cannot release budget or recreate the removed original receipt.
      port.maintain();
      expect(h.db.$client.prepare('SELECT * FROM room_turn_spend ORDER BY id').all()).toEqual(
        spends
      );
      expect(
        h.db.$client
          .prepare('SELECT * FROM room_doc_admissions WHERE admission_id=?')
          .get(h.admission.admission_id)
      ).toEqual(after);
    } catch (cause) {
      failed = true;
      primary = cause;
    } finally {
      try {
        await h.cleanup();
      } catch (cause) {
        if (!failed) {
          failed = true;
          primary = cause;
        }
      }
    }
    if (failed) throw primary;
  }
);

it('reopens the same genuine FILE and quarantines its actual previous-boot claim without resend', async () => {
  const h = await originalNativeRetentionSource('claimed');
  let reopened: Awaited<ReturnType<typeof reopenNativeRoomAuthorityFixture>> | undefined;
  let failed = false;
  let primary: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      primary = cause;
    }
  };
  try {
    const before = h.db.$client
      .prepare('SELECT * FROM room_doc_admissions WHERE admission_id=?')
      .get(h.admission.admission_id) as {
      admission_id: string;
      batch_id: string;
      generation: string;
      source_attempt: number;
      dispatch_id: string;
      spend_row_id: number;
      status: string;
      boot_epoch: string;
    };
    expect(before.status).toBe('claimed');
    const spends = h.db.$client.prepare('SELECT * FROM room_turn_spend ORDER BY id').all();
    const prompts = nativeRetentionSdk.prompts.length;
    h.db.$client.close();
    reopened = await reopenNativeRoomAuthorityFixture(h);
    // Actual new facade construction runs recovery before publishing private responder membership.
    currentRoomDueServicePort(reopened.http.service).maintain();
    const after = reopened.db.$client
      .prepare('SELECT * FROM room_doc_admissions WHERE admission_id=?')
      .get(h.admission.admission_id) as typeof before & { outcome: string };
    expect(after).toMatchObject({
      admission_id: before.admission_id,
      batch_id: before.batch_id,
      generation: before.generation,
      source_attempt: before.source_attempt,
      dispatch_id: before.dispatch_id,
      spend_row_id: before.spend_row_id,
      boot_epoch: before.boot_epoch,
      status: 'in_doubt',
      outcome: 'in_doubt',
    });
    expect(reopened.db.$client.prepare('SELECT * FROM room_turn_spend ORDER BY id').all()).toEqual(
      spends
    );
    const { prepareServiceOriginalRoomResponder } = await import('../service.js');
    expect(
      await prepareServiceOriginalRoomResponder(
        reopened.http.service,
        h.runtime,
        { on: vi.fn() },
        h.originalTarget.canonicalSessionId
      )
    ).toBeUndefined();
    const { startCodexCommittedRoomResponder } =
      await import('../../../runtimes/codex/codex-runtime.js');
    expect(() => startCodexCommittedRoomResponder(h.runtime, h.prepared, h.committed)).toThrow();
    expect(nativeRetentionSdk.prompts).toHaveLength(prompts);
    expect(reopened.db.$client.inTransaction).toBe(false);
  } catch (cause) {
    remember(cause);
  } finally {
    try {
      await reopened?.cleanup();
    } catch (cause) {
      remember(cause);
    }
    try {
      await h.cleanup();
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw primary;
});
