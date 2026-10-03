/** Real FILE rows stay fresh; compiled query reuse is never authority or a retained result. */
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {
  createDb,
  runMigrations,
  canvasDocChannels,
  canvasDocGrants,
  canvasDocWriteIntents,
  canvasDocEvents,
  eq,
  type DbTransaction,
} from '@dorkos/db';
import { DocChannelStore, DocChannelCorruptionError } from '../store.js';
import { fixture as checkboxFixture } from '../writes/__tests__/checkbox-fixture.js';

const NOW = '2026-10-03T12:00:00.000Z';
const LATER = '2026-10-03T12:01:00.000Z';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function bare() {
  const dir = await mkdtemp(join(tmpdir(), 'prepared-doc-reader-'));
  const file = join(dir, 'db.sqlite');
  const db = createDb(file);
  runMigrations(db);
  cleanups.push(async () => {
    if (db.$client.open) db.$client.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new DocChannelStore(db);
  store.initialize({
    documentId: 'document-1',
    scope: 'session:session-1',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { db, store, file };
}
async function changed() {
  const h = await checkboxFixture();
  cleanups.push(h.cleanup);
  const input = await h.request();
  const receipt = await h.service.toggle(input, h.actor);
  expect(receipt.status).toBe('changed');
  return { ...h, input, receipt, intent: h.row() };
}

it('reuses four compiled shapes but executes every fresh full-row read inside genuine A scope', async () => {
  const h = await changed();
  const prepared = vi.spyOn(h.db.$client, 'prepare');
  h.authority.transaction((tx) => {
    const read = () => [
      h.store.getChannel(h.documentId, tx),
      h.store.getGrant(h.grantId, tx),
      h.store.getWriteIntent(h.intent.intentId, tx),
      h.store.getEvent(h.documentId, h.input.eventId, tx),
    ];
    const beforeEvent = h.store.getEvent(h.documentId, h.input.eventId, tx);
    const before = read();
    const count = prepared.mock.calls.length;
    expect(read()).toEqual(before);
    expect(prepared.mock.calls.length).toBe(count);
    tx.update(canvasDocChannels)
      .set({ updatedAt: LATER })
      .where(eq(canvasDocChannels.documentId, h.documentId))
      .run();
    tx.update(canvasDocGrants)
      .set({ revokedAt: LATER })
      .where(eq(canvasDocGrants.grantId, h.grantId))
      .run();
    tx.update(canvasDocWriteIntents)
      .set({ errorCode: 'fresh-row' })
      .where(eq(canvasDocWriteIntents.intentId, h.intent.intentId))
      .run();
    tx.update(canvasDocEvents)
      .set({ payload: { fresh: true } })
      .where(eq(canvasDocEvents.eventId, h.input.eventId))
      .run();
    const [channel, grant, intent, event] = read();
    expect(channel).toMatchObject({ updatedAt: LATER });
    expect(grant).toMatchObject({ revokedAt: LATER });
    expect(intent).toMatchObject({ errorCode: 'fresh-row' });
    expect(event).toMatchObject({ payload: { fresh: true }, provenance: beforeEvent!.provenance });
  });
});

it('keeps real NULL, absent rows and caller parameters distinct on repeated executions', async () => {
  const h = await changed();
  h.store.transaction((tx) => {
    expect(h.store.getGrant(h.grantId, tx)?.revokedAt).toBeNull();
    expect(h.store.getEvent(h.documentId, h.input.eventId, tx)?.payloadPrunedAt).toBeNull();
    expect(h.store.getChannel('absent', tx)).toBeUndefined();
    expect(h.store.getGrant('absent', tx)).toBeUndefined();
    expect(h.store.getWriteIntent('absent', tx)).toBeUndefined();
    expect(h.store.getEvent('absent', h.input.eventId, tx)).toBeUndefined();
    expect(h.store.getEvent(h.documentId, 'absent', tx)).toBeUndefined();
    expect(h.store.getChannel(h.documentId, tx)?.documentId).toBe(h.documentId);
    expect(h.store.getWriteIntent(h.intent.intentId, tx)).toEqual(h.intent);
  });
});

it.each(['commit', 'rollback'] as const)(
  'retires a cached prepared handle after %s, while a fresh scope works',
  async (end) => {
    const h = await bare();
    let escaped: DbTransaction | undefined;
    const work = () =>
      h.store.transaction((tx) => {
        escaped = tx;
        expect(h.store.getChannel('document-1', tx)?.updatedAt).toBe(NOW);
        expect(h.store.getChannel('document-1', tx)?.updatedAt).toBe(NOW);
        if (end === 'rollback') throw new Error('expected rollback');
      });
    if (end === 'rollback') expect(work).toThrow('expected rollback');
    else work();
    expect(escaped).toBeDefined();
    expect(() => h.store.getChannel('document-1', escaped!)).toThrow(
      'transaction is no longer active'
    );
    h.store.transaction((tx) => expect(h.store.getChannel('document-1', tx)?.updatedAt).toBe(NOW));
  }
);

it('isolates foreign FILE and same-native different-wrapper compiled handles', async () => {
  const first = await bare(),
    second = await bare();
  second.db.update(canvasDocChannels).set({ scope: 'session:foreign' }).run();
  expect(first.store.getChannel('document-1')?.scope).toBe('session:session-1');
  expect(second.store.getChannel('document-1')?.scope).toBe('session:foreign');
  const schema = first.db._.fullSchema;
  if (!schema) throw new Error('The genuine schema is unavailable.');
  const wrapper = drizzle(first.db.$client, { schema });
  const wrappedStore = new DocChannelStore(wrapper);
  const prepare = vi.spyOn(first.db.$client, 'prepare');
  const beforeWrapper = prepare.mock.calls.length;
  wrappedStore.getChannel('document-1');
  expect(prepare.mock.calls.length).toBe(beforeWrapper + 1);
  const count = prepare.mock.calls.length;
  first.store.getChannel('document-1');
  // The first store was already primed; the other wrapper did not replace its exact key.
  expect(prepare.mock.calls.length).toBe(count);
  first.db.update(canvasDocChannels).set({ scope: 'session:current' }).run();
  expect(wrappedStore.getChannel('document-1')?.scope).toBe('session:current');
  expect(first.store.getChannel('document-1')?.scope).toBe('session:current');
  expect(second.store.getChannel('document-1')?.scope).toBe('session:foreign');
});

it('retains current corruption validation and original syntax cause after a successful cached read', async () => {
  const h = await bare();
  expect(h.store.getChannel('document-1')?.state).toEqual({});
  h.db.$client
    .prepare('UPDATE canvas_doc_channels SET state = ? WHERE document_id = ?')
    .run('{invalid', 'document-1');
  try {
    h.store.getChannel('document-1');
    throw new Error('Corrupt current state was exposed.');
  } catch (error) {
    expect(error).toBeInstanceOf(DocChannelCorruptionError);
    expect(error).toMatchObject({
      table: 'canvas_doc_channels',
      recordId: 'document-1',
      cause: expect.any(SyntaxError),
    });
  }
  h.db.$client
    .prepare('UPDATE canvas_doc_channels SET state = ?, next_doc_seq = ? WHERE document_id = ?')
    .run('{}', 0, 'document-1');
  expect(() => h.store.getChannel('document-1')).toThrow(DocChannelCorruptionError);
  h.db.$client
    .prepare('UPDATE canvas_doc_channels SET next_doc_seq = ? WHERE document_id = ?')
    .run(1, 'document-1');
  expect(h.store.getChannel('document-1')?.state).toEqual({});
});

it('keeps an actual second-connection exclusive-lock refusal and succeeds freshly after release', async () => {
  const h = await bare();
  h.db.$client.pragma('journal_mode=DELETE');
  const other = new Database(h.file);
  cleanups.push(async () => {
    if (other.open) other.close();
  });
  // A short native lock wait injects SQLITE_BUSY; the test deadline remains its original default.
  h.db.$client.pragma('busy_timeout=1');
  expect(h.store.getChannel('document-1')?.documentId).toBe('document-1');
  other.exec('BEGIN EXCLUSIVE');
  try {
    expect(() => h.store.getChannel('document-1')).toThrow(
      expect.objectContaining({ code: 'SQLITE_BUSY' })
    );
  } finally {
    other.exec('ROLLBACK');
  }
  expect(h.store.getChannel('document-1')?.documentId).toBe('document-1');
});

it('preserves unavailable storage and closed DB failures instead of returning a cached row', async () => {
  const h = await bare();
  expect(h.store.getChannel('document-1')?.documentId).toBe('document-1');
  h.db.$client.exec('DROP TABLE canvas_doc_channels');
  expect(() => h.store.getChannel('document-1')).toThrow();
  h.db.$client.close();
  expect(() => h.store.getChannel('document-1')).toThrow();
});

it('observes a second-connection original grant revoke across an actual held filesystem boundary', async () => {
  let release!: () => void, reached!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const staged = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const h = await checkboxFixture({
    checkpoint: async (point) => {
      if (point === 'staged') {
        reached();
        await pending;
      }
    },
  });
  cleanups.push(async () => {
    release();
    await h.cleanup();
  });
  const input = await h.request();
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  expect(h.store.getGrant(h.grantId)?.revokedAt).toBeNull();
  const other = createDb(h.file);
  cleanups.push(async () => {
    other.$client.close();
  });
  const result = h.service.toggle(input, h.actor);
  // Observe rejection immediately; no unhandled continuation or invented transaction snapshot.
  const observed = result.then(
    (receipt) => ({ receipt }),
    (error: unknown) => ({ error })
  );
  try {
    await staged;
    other
      .update(canvasDocGrants)
      .set({ revokedAt: LATER })
      .where(eq(canvasDocGrants.grantId, h.grantId))
      .run();
  } finally {
    release();
  }
  const settled = await observed;
  expect(settled).toHaveProperty('error');
  expect(h.store.getGrant(h.grantId)?.revokedAt).toBe(LATER);
  expect(await readFile(h.path)).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.row().eventId).toBe(input.eventId);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
