import { mkdtemp, realpath, stat, link, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { canvasDocWriteIntents, eq } from '@dorkos/db';
import { fixture } from './checkbox-fixture.js';
import { randomUUID } from 'node:crypto';
import { rawByteHash } from '../checkbox-bytes.js';
import {
  CheckboxWriteFence,
  CheckboxFenceUnavailableError,
  CheckboxWriteFencedError,
} from '../checkbox-fence.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const h = await fixture(options);
  cleanups.push(h.cleanup);
  return h;
}
async function identity(path: string) {
  const canonicalPath = await realpath(path),
    info = await stat(path, { bigint: true });
  return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
}
async function uncertain() {
  const h = await setup();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('completion rollback');
  expect(h.row().status).toBe('replaced');
  return h;
}
function setEvidence(h: Awaited<ReturnType<typeof setup>>, evidence: unknown) {
  h.db
    .update(canvasDocWriteIntents)
    .set({ evidence })
    .where(eq(canvasDocWriteIntents.intentId, h.row().intentId))
    .run();
}

it('persists actual bigint original identity before the prepared checkpoint and preserves it on restart', async () => {
  let observed: unknown;
  const h = await setup({
    checkpoint: async (point, row) => {
      if (point === 'prepared') {
        observed = row.evidence;
        throw new Error('prepared interruption');
      }
    },
  });
  const original = await identity(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow(
    'prepared interruption'
  );
  expect(observed).toMatchObject({
    v: 2,
    originalIdentity: { device: original.device, inode: original.inode },
    tempIdentity: null,
  });
  const row = h.row();
  await h.service.stop();
  h.db.$client.close();
  const reopened = await fixture({}, { dir: h.dir, documentId: h.documentId, grantId: h.grantId });
  cleanups.push(reopened.cleanup);
  expect(reopened.row().evidence).toEqual(row.evidence);
  expect(reopened.service.writeFence.readiness()).toEqual({ ready: true });
  expect(() => reopened.service.writeFence.assertAdmission(original)).toThrow(
    CheckboxWriteFencedError
  );
});

it('fences original and replacement hardlink aliases across file restart and releases only after terminal recovery', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'checkbox-cross-tree-'));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  const h = await setup();
  const oldAlias = join(outside, 'original.md');
  await link(h.path, oldAlias);
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('completion rollback');
  const replacementAlias = join(outside, 'replacement.md');
  await link(h.path, replacementAlias);
  expect((await stat(oldAlias, { bigint: true })).nlink).toBe(1n);
  const before = h.row().evidence;
  await h.service.stop();
  h.db.$client.close();
  const reopened = await fixture({}, { dir: h.dir, documentId: h.documentId, grantId: h.grantId });
  cleanups.push(reopened.cleanup);
  // Resolve actual alias identities outside SQL before applying the synchronous census.
  for (const path of [oldAlias, replacementAlias, reopened.path]) {
    const actual = await identity(path);
    expect(() => reopened.service.writeFence.assertAdmission(actual)).toThrow(
      CheckboxWriteFencedError
    );
  }
  expect(reopened.row().evidence).toEqual(before);
  reopened.failCompletion(false);
  expect((await reopened.service.recover(reopened.row().intentId)).status).toBe('changed');
  for (const path of [oldAlias, replacementAlias, reopened.path]) {
    const actual = await identity(path);
    expect(() => reopened.service.writeFence.assertAdmission(actual)).not.toThrow();
  }
});

it('distinguishes fresh same-byte inodes while retaining the unresolved canonical pathname fence', async () => {
  const h = await uncertain(),
    original = await identity(h.path),
    bytes = await readFile(h.path);
  const independent = join(h.dir, 'fresh.md');
  await writeFile(independent, bytes);
  const fresh = await identity(independent);
  expect(fresh.inode).not.toBe(original.inode);
  expect(() => h.service.writeFence.assertAdmission(fresh)).not.toThrow();
  await rename(independent, h.path);
  const replaced = await identity(h.path);
  expect(replaced.inode).not.toBe(original.inode);
  expect(() => h.service.writeFence.assertAdmission(replaced)).toThrow(CheckboxWriteFencedError);
  await expect(h.service.recover(h.row().intentId)).rejects.toThrow(
    'Checkbox replacement evidence changed.'
  );
  expect(h.row().status).toBe('in_doubt');
});

it('keeps legacy unknown original aliases globally closed even with one surviving link, when genuine fixed completion cannot establish original physical evidence', async () => {
  const h = await setup();
  const outside = await mkdtemp(join(tmpdir(), 'checkbox-legacy-alias-'));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  const alias = join(outside, 'old.md');
  await link(h.path, alias);
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('completion rollback');
  const evidence = h.service.validate(h.row());
  const legacy: Record<string, unknown> = { ...evidence };
  delete legacy.originalIdentity;
  setEvidence(h, { ...legacy, v: 1 });
  expect((await stat(alias, { bigint: true })).nlink).toBe(1n);
  const unrelated = join(outside, 'unrelated.md');
  await writeFile(unrelated, 'unrelated');
  const physical = await identity(unrelated);
  expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'legacy' });
  expect(() => h.service.writeFence.assertAdmission(physical)).toThrow(
    CheckboxFenceUnavailableError
  );
  h.failCompletion(false);
  await expect(h.service.recover(h.row().intentId)).rejects.toThrow('current physical evidence');
  expect(h.row().status).toBe('in_doubt');
  expect(h.service.validate(h.row()).v).toBe(1);
  expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'legacy' });
  expect(() => h.service.writeFence.assertAdmission(physical)).toThrow(
    CheckboxFenceUnavailableError
  );
});

it.each([
  'missing',
  'leading-zero',
  'negative',
  'contradictory-version',
  'same-replacement',
] as const)(
  'keeps %s physical evidence corrupt and fenced rather than treating it as an empty census',
  async (kind) => {
    const h = await uncertain();
    const evidence = h.service.validate(h.row());
    if (evidence.v !== 2) throw new Error('expected v2');
    const changed: Record<string, unknown> = { ...evidence };
    if (kind === 'missing') delete changed.originalIdentity;
    if (kind === 'leading-zero') changed.originalIdentity = { device: '01', inode: '2' };
    if (kind === 'negative') changed.originalIdentity = { device: '1', inode: '-2' };
    if (kind === 'contradictory-version') changed.v = 1;
    if (kind === 'same-replacement') changed.originalIdentity = evidence.tempIdentity;
    setEvidence(h, changed);
    expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'corrupt' });
    const actual = await identity(h.path);
    expect(() => h.service.writeFence.assertAdmission(actual)).toThrow(
      CheckboxFenceUnavailableError
    );
    expect(h.row().status).toBe('replaced');
  }
);

it('fails closed on a missing owned current row and rereads state when that read is restored', async () => {
  const h = await uncertain(),
    actual = await identity(h.path),
    row = h.row();
  const get = vi.spyOn(h.store, 'getWriteIntent').mockReturnValue(undefined);
  expect(() => h.service.writeFence.assertOwnedIntentAdmission(actual, row)).toThrow(
    CheckboxFenceUnavailableError
  );
  get.mockRestore();
  expect(() => h.service.writeFence.assertAdmission(actual)).toThrow(CheckboxWriteFencedError);
});

it('retains the fence through a genuine SQLite exclusive read lock and rechecks after release', async () => {
  const h = await uncertain();
  const actual = await identity(h.path);
  h.db.$client.pragma('journal_mode = DELETE');
  h.db.$client.pragma('busy_timeout = 1');
  const other = new Database(h.file);
  other.exec('BEGIN EXCLUSIVE');
  try {
    expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'transient' });
    expect(() => h.service.writeFence.assertAdmission(actual)).toThrow(
      CheckboxFenceUnavailableError
    );
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
  expect(() => h.service.writeFence.assertAdmission(actual)).toThrow(CheckboxWriteFencedError);
});

it('refuses native SQL admission and checkbox work without resolving any filesystem path', async () => {
  const h = await setup();
  const request = await h.request();
  const port = (
    h.coordinator as unknown as { ports: { resolve: (path: string) => Promise<unknown> } }
  ).ports;
  const spy = vi.spyOn(port, 'resolve');
  h.db.$client.exec('BEGIN');
  try {
    expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'transaction' });
    await expect(h.service.toggle(request, h.actor)).rejects.toThrow('not available');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    h.db.$client.exec('ROLLBACK');
  }
});

it('validates every bounded keyset page rather than accepting an early physical match', async () => {
  const h = await uncertain(),
    original = h.row();
  const evidence = h.service.validate(original);
  for (let index = 0; index < 201; index++) {
    const intentId = `page-${String(index).padStart(4, '0')}`,
      eventId = randomUUID();
    const input = { ...(original.input as object), eventId };
    const seeded = {
      ...original,
      intentId,
      eventId,
      input,
      envelopeHash: rawByteHash(Buffer.from(JSON.stringify(input))),
      evidence: { ...evidence, tempPath: join(h.dir, `.dork-checkbox-${intentId}.tmp`) },
    };
    h.service.validate(seeded);
    // Synthetic census setup retains all rows; actual fence decisions still scan every page.
    h.store.transaction((tx) => tx.insert(canvasDocWriteIntents).values(seeded).run());
    h.service.validate(h.store.getWriteIntent(intentId)!);
  }
  expect(h.service.writeFence.readiness()).toEqual({ ready: true });
  const actual = await identity(h.path);
  expect(() => h.service.writeFence.assertAdmission(actual)).toThrow(CheckboxWriteFencedError);
  h.db.$client
    .prepare("UPDATE canvas_doc_write_intents SET evidence='{}' WHERE intent_id='page-0200'")
    .run();
  const prepare = vi.spyOn(h.db.$client, 'prepare');
  expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'corrupt' });
  expect(prepare.mock.calls.filter(([query]) => query.includes('NOT IN'))).toHaveLength(3);
  prepare.mockClear();
  expect(() => h.service.writeFence.assertAdmission(actual)).toThrow(CheckboxFenceUnavailableError);
  expect(prepare.mock.calls.filter(([query]) => query.includes('NOT IN'))).toHaveLength(3);
});

it('rereads owned current durable state after staging and refuses an externally changed row before rename', async () => {
  const h: Awaited<ReturnType<typeof setup>> = await setup({
    checkpoint: async (point, row) => {
      if (point === 'staged')
        h.db
          .update(canvasDocWriteIntents)
          .set({ updatedAt: '2026-10-02T00:00:00.000Z' })
          .where(eq(canvasDocWriteIntents.intentId, row.intentId))
          .run();
    },
  });
  const bytes = await readFile(h.path),
    physical = await identity(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow(
    CheckboxFenceUnavailableError
  );
  expect(await readFile(h.path)).toEqual(bytes);
  expect(await identity(h.path)).toEqual(physical);
  expect(h.row().status).toBe('prepared');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('refuses a genuinely separately approved original hardlink source through the complete unresolved census', async () => {
  const h = await setup();
  const alias = join(h.dir, 'alias.md');
  await link(h.path, alias);
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('completion rollback');
  const bytes = await readFile(alias),
    counts = h.counts(),
    originalGrant = h.store.getGrant(h.grantId);
  const approvedAlias = await h.approveAlias(alias);
  cleanups.push(() => approvedAlias.service.stop());
  expect(approvedAlias.grant.grantId).not.toBe(h.grantId);
  expect(h.store.getGrant(h.grantId)).toEqual(originalGrant);
  const awaitedIdentity = await identity(alias);
  expect(() => h.service.writeFence.assertAdmission(awaitedIdentity)).toThrow(
    CheckboxWriteFencedError
  );
  await expect(
    approvedAlias.service.toggle(
      {
        documentId: approvedAlias.documentId,
        eventId: randomUUID(),
        line: 1,
        textHash: rawByteHash(bytes.subarray(0, bytes.indexOf(13))),
        expectedFileVersion: rawByteHash(bytes),
        done: true,
      },
      h.actor
    )
  ).rejects.toThrow(CheckboxWriteFencedError);
  expect(await readFile(alias)).toEqual(bytes);
  expect(h.counts()).toEqual(counts);
});

it('requires a standalone fence to scan its genuine store database, preserving unresolved aliases on reopen', async () => {
  const owning = await uncertain(),
    foreign = await setup();
  const row = owning.row(),
    bytes = await readFile(owning.path),
    inode = (await stat(owning.path)).ino;
  const originalGrant = owning.store.getGrant(owning.grantId);
  const alias = join(owning.dir, 'constructor-alias.md');
  await link(owning.path, alias);
  const fence = new CheckboxWriteFence(owning.db, owning.store);
  for (const path of [owning.path, alias]) {
    const actual = await identity(path);
    expect(() => fence.assertAdmission(actual)).toThrow(CheckboxWriteFencedError);
  }
  expect(() => new CheckboxWriteFence(foreign.db, owning.store)).toThrow(
    'Checkbox authority requires its genuine store transaction database.'
  );
  expect(owning.row()).toEqual(row);
  expect(foreign.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(await readFile(owning.path)).toEqual(bytes);
  expect((await stat(owning.path)).ino).toBe(inode);
  await owning.service.stop();
  owning.db.$client.close();
  cleanups.splice(cleanups.indexOf(owning.cleanup), 1);
  const reopened = await fixture(
    {},
    { dir: owning.dir, documentId: owning.documentId, grantId: owning.grantId }
  );
  cleanups.push(reopened.cleanup);
  expect(() => new CheckboxWriteFence(reopened.db, owning.store)).toThrow(
    'Checkbox authority requires its genuine store transaction database.'
  );
  expect(reopened.store.getGrant(reopened.grantId)).toEqual(originalGrant);
  expect(reopened.row()).toEqual(row);
  const current = new CheckboxWriteFence(reopened.db, reopened.store);
  for (const path of [reopened.path, alias]) {
    const actual = await identity(path);
    expect(() => current.assertAdmission(actual)).toThrow(CheckboxWriteFencedError);
  }
  reopened.failCompletion(false);
  const receipt = await reopened.service.recover(row.intentId);
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: row.eventId } });
  expect(await reopened.service.recover(row.intentId)).toEqual(receipt);
  expect(reopened.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await readFile(reopened.path)).toEqual(bytes);
  expect((await stat(reopened.path)).ino).toBe(inode);
});

it('refuses a standalone fence database wrapper even over the same native connection', async () => {
  const owning = await setup();
  const schema = owning.db._.fullSchema;
  if (!schema) throw new Error('The genuine fixture schema is unavailable.');
  const wrapper = drizzle(owning.db.$client, { schema });
  expect(() => new CheckboxWriteFence(wrapper, owning.store)).toThrow(
    'Checkbox authority requires its genuine store transaction database.'
  );
  const actual = await identity(owning.path);
  expect(() =>
    new CheckboxWriteFence(owning.db, owning.store).assertAdmission(actual)
  ).not.toThrow();
  expect(owning.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(owning.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
