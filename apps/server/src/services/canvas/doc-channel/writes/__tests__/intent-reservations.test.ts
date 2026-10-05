import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  canvasDocWriteIntents,
  canvasDocChannels,
  canvasDocGrants,
  createDb,
  runMigrations,
  eq,
} from '@dorkos/db';
const NOW = '2026-10-01T00:00:00.000Z';
import {
  observedCheckboxIntent,
  validateCheckboxEvidence,
  preEffectCheckboxConflict,
  type CheckboxRequest,
} from '../checkbox-evidence.js';
import { prepareCheckboxBytes, rawByteHash } from '../checkbox-bytes.js';
import { projectVerifiedCheckbox } from '../completion.js';
import { documentTransaction } from '../../store-transaction.js';
import {
  scanCheckboxReservations,
  CheckboxReservationCensusError,
} from '../intent-reservations.js';
import type { DocWriteIntentRow } from '../../store.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// These real ledger/FK/parser fixtures test evidence accounting, not permission to write.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'checkbox-reservations-'));
  const file = join(root, 'ledger.sqlite');
  const db = createDb(file);
  runMigrations(db);
  const documentId = randomUUID();
  const grantId = randomUUID();
  db.insert(canvasDocChannels)
    .values({ documentId, scope: 'session:owner', createdAt: NOW, updatedAt: NOW })
    .run();
  db.insert(canvasDocGrants)
    .values({
      grantId,
      documentId,
      routeId: 'route',
      revision: 1,
      normalizedRoute: {
        id: 'route',
        on: 'md.task.toggled',
        to: 'agent:owner',
        turn: { mode: 'immediate', maxBatch: 100 },
      },
      routeHash: 'a'.repeat(64),
      declarationHash: 'b'.repeat(64),
      approvedBy: 'recorded-operator',
      approvalEvidence: { binding: 'fixture-evidence-accounting-only' },
      limits: { eventsPerMinute: 120 },
      allowedTypes: ['md.task.toggled'],
      createdAt: NOW,
    })
    .run();
  const h = { db, documentId, grantId };
  cleanups.push(async () => {
    h.db.$client.close();
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'tasks.md');
  await writeFile(path, '- [ ] café😀\r\n');
  const bytes = await readFile(path);
  const physical = await stat(path, { bigint: true });
  const authority = {
    documentId: h.documentId,
    grantId: h.grantId,
    grantRevision: 1,
    documentGeneration: 'physical-incarnation',
    routeId: 'route',
    routeHash: 'a'.repeat(64),
    binding: {
      operation: 'checkbox-toggle' as const,
      sourceIdentity: 'original-source',
      canonicalPath: path,
      resolvedCwd: root,
      treeKind: 'agent-cwd' as const,
    },
  };
  const request = (): CheckboxRequest => ({
    documentId: h.documentId,
    eventId: randomUUID(),
    line: 1,
    textHash: rawByteHash(Buffer.from('- [ ] café😀')),
    expectedFileVersion: rawByteHash(bytes),
    done: true,
  });
  const make = (
    status: 'prepared' | 'replaced' | 'in_doubt' | 'no_op' | 'conflict' = 'prepared'
  ) => {
    const input = request();
    const edit = prepareCheckboxBytes(bytes, { ...input, done: status !== 'no_op' });
    if (status === 'no_op') input.done = false;
    const built = observedCheckboxIntent(
      input,
      structuredClone(authority),
      rawByteHash(Buffer.from(JSON.stringify(input))),
      NOW,
      rawByteHash(bytes),
      { device: String(physical.dev), inode: String(physical.ino) },
      status === 'conflict' ? undefined : edit
    );
    return { ...built.intent, status } as DocWriteIntentRow;
  };
  const insert = (row: DocWriteIntentRow) => h.db.insert(canvasDocWriteIntents).values(row).run();
  const scan = (key = { documentId: h.documentId }) =>
    h.db.transaction((tx) => scanCheckboxReservations(tx, key));
  return { ...h, root, file, authority, request, make, insert, scan };
}

it('scans 205 originals through 100-row pages and never credits the matching caller row', async () => {
  const h = await fixture();
  const rows = Array.from({ length: 205 }, () => h.make());
  h.db.transaction(() => {
    for (const row of rows) h.insert(row);
  });
  const result = h.db.transaction((tx) =>
    scanCheckboxReservations(tx, {
      documentId: h.documentId,
      eventId: rows[0]!.eventId,
      routeId: 'route',
    })
  );
  const bytes = rows.reduce((total, row) => total + projectVerifiedCheckbox(row).identity.bytes, 0);
  expect(result.validated).toBe(205);
  expect(result.installation).toEqual({ originals: 205, rateUnits: 205, bytes });
  expect(result.document).toEqual(result.installation);
  expect(result.route.originals).toBe(205);
  expect(result.matchingIntent).toEqual(rows[0]);
  expect(Object.isFrozen(result.matchingIntent?.evidence)).toBe(true);
  expect(result.route.mixedIdentity).toBe(false);
});

it('refuses a corrupt final page even with an early UUID match and over-capacity prefix', async () => {
  const h = await fixture();
  const rows = Array.from({ length: 205 }, (_, i) => {
    const row = h.make();
    row.intentId = String(i).padStart(5, '0');
    (row.evidence as { tempPath: string }).tempPath = join(
      h.root,
      `.dork-checkbox-${row.intentId}.tmp`
    );
    return row;
  });
  h.db.transaction(() => {
    for (const row of rows) h.insert(row);
  });
  expect(h.scan().validated).toBe(205);
  h.db.$client
    .prepare('UPDATE canvas_doc_write_intents SET status=? WHERE intent_id=?')
    .run('unknown', '00204');
  expect(() =>
    h.db.transaction((tx) =>
      scanCheckboxReservations(tx, { documentId: h.documentId, eventId: rows[0]!.eventId })
    )
  ).toThrow(CheckboxReservationCensusError);
});

it('keeps opaque terminal conflict UUIDs without pretending to project observed bytes', async () => {
  const h = await fixture();
  const input = { ...h.request(), expectedFileVersion: 'server-version:opaque' };
  const row = preEffectCheckboxConflict(
    input,
    h.authority,
    rawByteHash(Buffer.from(JSON.stringify(input))),
    NOW
  ).intent as DocWriteIntentRow;
  h.insert(row);
  expect(() => projectVerifiedCheckbox(row)).toThrow();
  const result = h.db.transaction((tx) =>
    scanCheckboxReservations(tx, { documentId: h.documentId, eventId: input.eventId })
  );
  expect(result.matchingIntent).toEqual(row);
  expect(result.installation).toEqual({ originals: 0, rateUnits: 0, bytes: 0 });
});

it('terminal receipts retain claims while every unresolved status holds indefinite originals and exact bytes', async () => {
  const h = await fixture();
  const rows = ['prepared', 'replaced', 'in_doubt', 'no_op', 'conflict'].map((status) =>
    h.make(status as Parameters<typeof h.make>[0])
  );
  rows.forEach((row) => {
    row.createdAt = '2000-01-01T00:00:00.000Z';
    h.insert(row);
  });
  expect(h.scan().installation).toEqual({
    originals: 3,
    rateUnits: 3,
    bytes: rows.slice(0, 3).reduce((n, row) => n + projectVerifiedCheckbox(row).identity.bytes, 0),
  });
  for (const row of rows.slice(3)) {
    expect(
      h.db.transaction((tx) =>
        scanCheckboxReservations(tx, { documentId: h.documentId, eventId: row.eventId })
      ).matchingIntent?.intentId
    ).toBe(row.intentId);
  }
});

it('reports mixed original route identities without discarding either hold or authorizing a slot', async () => {
  const h = await fixture();
  const first = h.make();
  const second = h.make();
  (second.evidence as { authority: { grantRevision: number } }).authority.grantRevision = 2;
  h.insert(first);
  h.insert(second);
  const result = h.db.transaction((tx) =>
    scanCheckboxReservations(tx, { documentId: h.documentId, routeId: 'route' })
  );
  expect(result.route).toMatchObject({ originals: 2, mixedIdentity: true });
  expect(
    h.db.transaction((tx) =>
      scanCheckboxReservations(tx, { documentId: h.documentId, routeId: 'other' })
    ).route.originals
  ).toBe(0);
});

it.each(['failed', 'legacy', 'missing_route', 'hash_changed', 'invalid_json', 'forged_terminal'])(
  'refuses unprovable %s evidence rather than freeing resources',
  async (kind) => {
    const h = await fixture();
    const row = h.make();
    if (kind === 'failed') row.status = 'failed';
    if (kind === 'legacy') {
      const legacy = row.evidence as { v: number; originalIdentity?: unknown };
      legacy.v = 1;
      delete legacy.originalIdentity;
      expect(validateCheckboxEvidence(row).v).toBe(1);
    }
    if (kind === 'missing_route')
      (row.evidence as { authority: { routeId: string | null } }).authority.routeId = null;
    if (kind === 'hash_changed') row.envelopeHash = '0'.repeat(64);
    if (kind === 'forged_terminal') row.status = 'committed';
    h.insert(row);
    if (kind === 'invalid_json')
      h.db.$client.prepare('UPDATE canvas_doc_write_intents SET evidence=?').run('{');
    expect(() => h.scan()).toThrow(CheckboxReservationCensusError);
  }
);

it('counts installation holds separately from requested document and never memoizes current tail rows', async () => {
  const h = await fixture();
  h.insert(h.make());
  const other = randomUUID();
  h.db
    .insert(canvasDocChannels)
    .values({ documentId: other, scope: 'session:other', createdAt: NOW, updatedAt: NOW })
    .run();
  expect(
    h.db.transaction((tx) => scanCheckboxReservations(tx, { documentId: other })).document.originals
  ).toBe(0);
  expect(
    h.db.transaction((tx) => scanCheckboxReservations(tx, { documentId: other })).installation
      .originals
  ).toBe(1);
  const second = new Database(h.file);
  try {
    second.prepare('UPDATE canvas_doc_write_intents SET status=?').run('unrecognized');
    expect(() => h.scan()).toThrow(CheckboxReservationCensusError);
  } finally {
    second.close();
  }
});

it('rolls caller SQL back after a corrupt tail and leaves every original intent unchanged', async () => {
  const h = await fixture();
  h.insert(h.make());
  const before = h.db
    .select()
    .from(canvasDocChannels)
    .where(eq(canvasDocChannels.documentId, h.documentId))
    .get()!;
  h.db.$client.prepare('UPDATE canvas_doc_write_intents SET status=?').run('unknown');
  expect(() =>
    h.db.transaction((tx) => {
      tx.update(canvasDocChannels)
        .set({ stateRev: 4 })
        .where(eq(canvasDocChannels.documentId, h.documentId))
        .run();
      scanCheckboxReservations(tx, { documentId: h.documentId });
    })
  ).toThrow(CheckboxReservationCensusError);
  expect(
    h.db
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, h.documentId))
      .get()!.stateRev
  ).toBe(before.stateRev);
  expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()).toEqual({
    n: 1,
  });
});

it('preserves actual native storage failure cause and refuses malformed requested identity', async () => {
  const h = await fixture();
  h.db.$client.exec('ALTER TABLE canvas_doc_write_intents RENAME TO unavailable_intents');
  let error: unknown;
  try {
    h.scan();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CheckboxReservationCensusError);
  expect((error as Error).cause).toBeDefined();
  expect(() =>
    h.db.transaction((tx) => scanCheckboxReservations(tx, { documentId: '' }))
  ).toThrow();
});

it('keeps committed UUIDs permanently but releases their validated resources', async () => {
  const h = await fixture();
  const row = h.make();
  row.status = 'committed';
  (row.evidence as { receipt?: unknown }).receipt = {
    status: 'changed',
    receipt: { id: row.eventId, status: 'recorded', docSeq: 1 },
    fileVersion: row.afterHash,
  };
  h.insert(row);
  const summary = h.db.transaction((tx) =>
    scanCheckboxReservations(tx, { documentId: h.documentId, eventId: row.eventId })
  );
  expect(summary.matchingIntent?.status).toBe('committed');
  expect(summary.installation.originals).toBe(0);
});

it('cannot read a retired scoped transaction and preserves its original cause', async () => {
  const h = await fixture();
  let read: (() => unknown) | undefined;
  documentTransaction(h.db, (tx) => {
    read = () => scanCheckboxReservations(tx, { documentId: h.documentId });
  });
  expect(read).toBeDefined();
  try {
    read!();
    throw new Error('Expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(CheckboxReservationCensusError);
    expect((error as Error).cause).toBeInstanceOf(Error);
  }
});

it('retains originals during actual second-connection SQLITE_BUSY and reads fresh evidence after release', async () => {
  const h = await fixture();
  h.insert(h.make());
  h.db.$client.pragma('journal_mode = DELETE');
  h.db.$client.pragma('busy_timeout = 0');
  const second = new Database(h.file);
  try {
    second.exec('BEGIN EXCLUSIVE');
    expect(() => h.scan()).toThrow(CheckboxReservationCensusError);
    second.exec('ROLLBACK');
    expect(h.scan().installation.originals).toBe(1);
    expect(second.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()).toEqual({
      n: 1,
    });
  } finally {
    if (second.inTransaction) second.exec('ROLLBACK');
    second.close();
  }
});
