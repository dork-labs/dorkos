/** Verify retention against independently measured persisted UTF-8 bytes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sql, canvasDocBatches, canvasDocDeliveries, eq, type Db } from '@dorkos/db';
import { batchFixture, NOW } from './batch-fixtures.js';
import { retainDocHistory, DOC_RETENTION_POLICY } from '../retention.js';
const databases: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tables = ['canvas_doc_events', 'canvas_doc_deliveries', 'canvas_doc_batches'] as const;
/** Derive every column from real migrated SQLite, independent of production accounting lists. */
function persistedBytes(db: Db, omitWarning = false) {
  let bytes = 0;
  let characters = 0;
  for (const table of tables) {
    const columns = db.$client.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const fields = columns
      .filter(({ name }) => !(omitWarning && name === 'waiting_warning_at'))
      .map(({ name }) => `'${name.replaceAll("'", "''")}',"${name.replaceAll('"', '""')}"`)
      .join(',');
    const row = db.$client
      .prepare(
        `SELECT coalesce(sum(length(CAST(json_object(${fields}) AS BLOB))),0) AS bytes,
      coalesce(sum(length(json_object(${fields}))),0) AS characters FROM ${table}`
      )
      .get() as { bytes: number; characters: number };
    bytes += row.bytes;
    characters += row.characters;
  }
  return { bytes, characters };
}
function completed(marker: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-warning-retention-'));
  directories.push(dir);
  const f = batchFixture(join(dir, 'state.db'));
  databases.push(f.db);
  f.input({ text: 'Unicode 🦉 café 東京 — persisted JSON' });
  const id = f.batchId();
  // Marking pending/unadmitted work must be a no-op, not an accounting shortcut.
  expect(
    f.store.transaction((tx) =>
      f.store.markWaitingWarning(id, f.store.getBatch(id)!.generation, NOW, tx)
    )
  ).toBe(false);
  expect(f.store.getBatch(id)!.waitingWarningAt).toBeNull();
  if (marker) {
    f.db
      .update(canvasDocBatches)
      .set({ status: 'waiting' })
      .where(eq(canvasDocBatches.batchId, id))
      .run();
    expect(
      f.store.transaction((tx) =>
        f.store.markWaitingWarning(id, f.store.getBatch(id)!.generation, NOW, tx)
      )
    ).toBe(true);
  }
  f.db
    .update(canvasDocBatches)
    .set({ status: 'turn_done' })
    .where(eq(canvasDocBatches.batchId, id))
    .run();
  f.db
    .update(canvasDocDeliveries)
    .set({ status: 'turn_done' })
    .where(eq(canvasDocDeliveries.batchId, id))
    .run();
  const actual = persistedBytes(f.db);
  const old = persistedBytes(f.db, true);
  expect(actual.bytes).toBeGreaterThan(old.bytes);
  expect(actual.bytes).toBeGreaterThan(actual.characters);
  expect(f.db.$client.prepare('PRAGMA table_info(canvas_doc_batches)').all()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'waiting_warning_at' })])
  );
  const rows = () => ({
    events: f.store.getEvent(f.documentId, f.store.getBatch(id)!.inputEventIds[0]!),
    deliveries: f.db.select().from(canvasDocDeliveries).all(),
    batch: f.store.getBatch(id),
  });
  return { f, id, actual: actual.bytes, old: old.bytes, rows };
}
it.each([false, true])(
  'preserves all completed persisted bytes at the exact cap, including warning marker=%s',
  (marker) => {
    const { f, actual, rows } = completed(marker);
    const before = rows();
    retainDocHistory(f.store, NOW, { documentBytes: actual, installationBytes: actual });
    expect(persistedBytes(f.db).bytes).toBe(actual);
    expect(rows()).toEqual(before);
  }
);
it.each([false, true])(
  'enforces the document-only one-byte deficit with persisted warning marker=%s',
  (marker) => {
    const { f, actual } = completed(marker);
    retainDocHistory(f.store, NOW, {
      documentBytes: actual - 1,
      installationBytes: DOC_RETENTION_POLICY.installationBytes,
    });
    expect(persistedBytes(f.db).bytes).toBeLessThanOrEqual(actual - 1);
  }
);
it.each([false, true])(
  'enforces the installation-only one-byte deficit with persisted warning marker=%s',
  (marker) => {
    const { f, actual } = completed(marker);
    retainDocHistory(f.store, NOW, {
      documentBytes: DOC_RETENTION_POLICY.documentBytes,
      installationBytes: actual - 1,
    });
    expect(persistedBytes(f.db).bytes).toBeLessThanOrEqual(actual - 1);
  }
);
it.each(['document', 'installation'] as const)(
  'enforces the independent old-column %s cap instead of retaining over-cap warning evidence',
  (scope) => {
    const { f, id, actual, old } = completed(true);
    retainDocHistory(f.store, NOW, {
      documentBytes: scope === 'document' ? old : DOC_RETENTION_POLICY.documentBytes,
      installationBytes: scope === 'installation' ? old : DOC_RETENTION_POLICY.installationBytes,
    });
    expect(persistedBytes(f.db).bytes).toBeLessThanOrEqual(old);
    expect(actual).toBeGreaterThan(old);
    // Any surviving correlation retains its actual marker; enforcement cannot erase just its evidence.
    const batch = f.store.getBatch(id);
    if (batch) expect(batch.waitingWarningAt).toBe(NOW);
  }
);

// The paid SDK process alone is replaced. Authority comes from the real original constructor/FILE DB.
const nativeRetentionSdk = vi.hoisted(() => ({
  options: [] as unknown[],
  prompts: [] as unknown[],
  parked: true,
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
        runStreamed: async (prompt: unknown) => {
          nativeRetentionSdk.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'native-retention-source' };
              if (nativeRetentionSdk.parked)
                await new Promise<void>((resolve) => {
                  nativeRetentionSdk.release = resolve;
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
import { nativeCommittedCodexRoomFixture } from '../writes/__tests__/authority-fixtures.js';
function originalNativeRetentionSource(disposition: 'settled' | 'unpulled' = 'settled') {
  nativeRetentionSdk.options.length = 0;
  nativeRetentionSdk.prompts.length = 0;
  nativeRetentionSdk.parked = true;
  nativeRetentionSdk.release = undefined;
  return nativeCommittedCodexRoomFixture(
    {
      options: nativeRetentionSdk.options,
      prompts: nativeRetentionSdk.prompts,
      releaseProducer: () => nativeRetentionSdk.release?.(),
      completeFutureTurns: () => {
        nativeRetentionSdk.parked = false;
      },
    },
    disposition
  );
}

it('includes every real native row column in observed UTF-8 history usage without truncating retained evidence', async () => {
  const h = await originalNativeRetentionSource();
  const nativeTables = [
    'canvas_doc_events',
    'canvas_doc_deliveries',
    'canvas_doc_batches',
    'room_doc_admissions',
    'room_doc_admission_inputs',
    'room_doc_exhausted_lineages',
  ] as const;
  let failed = false,
    first: unknown;
  try {
    let expected = 0;
    for (const table of nativeTables) {
      const columns = h.db.$client.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      const fields = columns
        .map(({ name }) => `'${name.replaceAll("'", "''")}',"${name.replaceAll('"', '""')}"`)
        .join(',');
      const total = h.db.$client
        .prepare(
          `SELECT coalesce(sum(length(CAST(json_object(${fields}) AS BLOB))),0) AS bytes FROM ${table}`
        )
        .get() as { bytes: number };
      expected += total.bytes;
    }
    const sample = h.db.$client.prepare('SELECT 1');
    const prototype = Object.getPrototypeOf(sample) as typeof sample;
    const originalAll = prototype.all;
    let observed = 0;
    const all = vi.spyOn(prototype, 'all').mockImplementation(function (
      this: typeof sample,
      ...args
    ) {
      const rows = originalAll.apply(this, args);
      if (
        this.source.includes('FROM room_doc_exhausted_lineages rx') &&
        this.source.includes('UNION ALL')
      ) {
        observed = (rows as { bytes: number }[]).reduce((sum, row) => sum + row.bytes, 0);
      }
      return rows;
    });
    try {
      retainDocHistory(h.http.channels, new Date().toISOString());
    } finally {
      all.mockRestore();
    }
    expect(expected).toBeGreaterThan(0);
    expect(observed).toBe(expected);
    expect(h.http.channels.getEvent(h.documentId, h.input.id)!.payload).toEqual(h.input.payload);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)).toEqual({
      n: 1,
    });
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
