/** Retention keeps bounded query work over real migrated, fully accounted history. */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { DocChannelStore } from '../store.js';
import { retainDocHistory } from '../retention.js';

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
