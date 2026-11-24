import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, writeFile, readdir, link } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { canvasDocWriteIntents } from '@dorkos/db';
import type { CheckboxRequest } from '../../checkbox-service.js';
import { rawByteHash } from '../../checkbox-bytes.js';
import { recoverCheckboxPage } from '../../write-recovery.js';
import { fixture } from './harness.js';
import { realpath } from 'node:fs/promises';
import Database from 'better-sqlite3';

it('recovery rejects internally inconsistent marker evidence even when the after hash matches', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  h.db.$client
    .prepare("UPDATE canvas_doc_write_intents SET evidence=json_set(evidence,'$.markerOffset',20)")
    .run();
  await expect(h.service.recover(h.row().intentId)).rejects.toThrow(
    'Checkbox reconstructed source differs.'
  );
  expect(h.row().status).toBe('in_doubt');
  expect(h.service.fenced(h.path)).toBe(true);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('rechecks changed same-ID evidence after a successful fence scan', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(h.service.writeFence.readiness()).toEqual({ ready: true });
  h.db.$client.prepare("UPDATE canvas_doc_write_intents SET before_hash='invalid'").run();
  expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'corrupt' });
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('recovery reads retain the fresh global corruption fence after validation reuse', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  const own = h.store.getWriteIntent(h.row().intentId)!;
  const intentId = randomUUID(),
    eventId = randomUUID();
  const input = { ...(own.input as CheckboxRequest), eventId };
  const other = {
    ...own,
    intentId,
    eventId,
    input,
    envelopeHash: rawByteHash(Buffer.from(JSON.stringify(input))),
    evidence: {
      ...h.service.validate(own),
      tempPath: join(h.dir, `.dork-checkbox-${intentId}.tmp`),
    },
  };
  h.store.transaction((tx) => tx.insert(canvasDocWriteIntents).values(other).run());
  const info = await stat(h.path, { bigint: true });
  const identity = {
    canonicalPath: await realpath(h.path),
    device: String(info.dev),
    inode: String(info.ino),
  };
  h.service.writeFence.assertRecoveryRead(identity, own);
  h.service.writeFence.assertRecoveryRead(identity, own);
  h.db.$client
    .prepare("UPDATE canvas_doc_write_intents SET evidence='{}' WHERE intent_id=?")
    .run(intentId);
  expect(() => h.service.writeFence.assertRecoveryRead(identity, own)).toThrow('unavailable');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('bounded recovery pages past a full page of original intents with a stable keyset and no effects', async () => {
  // Every seeded intent shares one updatedAt, so only the intentId tie-break can carry the cursor
  // past a page. Each recovery runs the full authority and fence checks (~10ms of CPU), so the
  // page is two rows, not the default 100: 101 recoveries timed out on loaded CI runners.
  const h = await fixture();
  const before = await readFile(h.path);
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  await writeFile(h.path, before);
  const base = h.store.getWriteIntent(h.row().intentId)!;
  h.db.$client.prepare("UPDATE canvas_doc_write_intents SET status='prepared'").run();
  for (let i = 0; i < 2; i++) {
    const intentId = randomUUID(),
      eventId = randomUUID();
    const input = { ...(base.input as CheckboxRequest), eventId };
    const evidence = {
      ...h.service.validate(base),
      tempPath: join(h.dir, `.dork-checkbox-${intentId}.tmp`),
    };
    const seeded = {
      ...base,
      intentId,
      eventId,
      input,
      envelopeHash: rawByteHash(Buffer.from(JSON.stringify(input))),
      evidence,
      status: 'prepared' as const,
    };
    h.service.validate(seeded);
    // Synthetic census setup; ordinary admission and its UUID guards are tested separately.
    h.store.transaction((tx) => tx.insert(canvasDocWriteIntents).values(seeded).run());
    h.service.validate(h.store.getWriteIntent(intentId)!);
  }
  const one = await recoverCheckboxPage(h.service, undefined, 2);
  expect(one).toMatchObject({ selected: 2, verified: 0, retryableFailures: 0, hasMore: true });
  const two = await recoverCheckboxPage(h.service, one.cursor, 2);
  expect(two).toMatchObject({ selected: 1, verified: 0, retryableFailures: 0, hasMore: false });
  expect(one.cursor).not.toEqual(two.cursor);
  expect(await readFile(h.path)).toEqual(before);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  await expect(
    recoverCheckboxPage(h.service, { updatedAt: 'invalid', intentId: 'x' })
  ).rejects.toThrow('cursor');
  await expect(recoverCheckboxPage(h.service, undefined, 101)).rejects.toThrow('limit');
  await expect(recoverCheckboxPage(h.service, undefined, 0)).rejects.toThrow('limit');
});

it('does not remove an unowned exclusive-create collider during failure or recovery', async () => {
  let colliding = '';
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point, intent) => {
      if (point === 'prepared') {
        colliding = join(h.dir, `.dork-checkbox-${intent.intentId}.tmp`);
        await writeFile(colliding, 'unowned');
      }
    },
  });
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await readFile(colliding, 'utf8')).toBe('unowned');
  expect((await h.service.recover(h.row().intentId)).status).toBe('in_doubt');
  expect(await readFile(colliding, 'utf8')).toBe('unowned');
  expect(await readFile(h.path)).toEqual(before);
});

it('rejects replaced staging inode before it can replace the source', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point, intent) => {
      if (point === 'staged') {
        const path = join(h.dir, `.dork-checkbox-${intent.intentId}.tmp`);
        const replacement = path + '.replacement';
        await writeFile(replacement, 'unowned replacement');
        expect((await stat(replacement, { bigint: true })).ino).not.toBe(
          (await stat(path, { bigint: true })).ino
        );
        await rename(replacement, path);
      }
    },
  });
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('replacement');
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('in_doubt');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('retains the actual replacement lease against a new cooperating hardlink writer until host completion', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'replaced') {
        entered();
        await held;
      }
    },
  });
  const input = await h.request();
  const operation = h.service.toggle(input, h.actor);
  await started;
  const alias = join(h.dir, 'alias');
  await link(h.path, alias);
  let writes = 0;
  const other = h.coordinator.withFiles([alias], async () => {
    writes++;
    await writeFile(alias, 'cooperating next write');
  });
  let result;
  try {
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(writes).toBe(0);
  } finally {
    release();
    result = await operation;
    await other;
  }
  expect(result!.status).toBe('changed');
  expect(writes).toBe(1);
  expect(h.row().status).toBe('committed');
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(result);
});

it('cleans its exclusively-created temp if current grant is lost before staging can commit', async () => {
  const h = await fixture();
  const refresh = h.authority.refreshCurrent.bind(h.authority);
  let checks = 0;
  h.authority.refreshCurrent = (...args) => {
    if (++checks === 2) h.revoke();
    return refresh(...args);
  };
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('prepared');
  expect((await readdir(h.dir)).filter((name) => name.startsWith('.dork-checkbox-'))).toEqual([]);
});

it('retains exact evidence when a genuine exclusive SQLite read lock is released before recovery handles its error', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  const original = h.row(),
    reader = h.store.getWriteIntent.bind(h.store),
    lock = new Database(h.file);
  h.db.$client.pragma('busy_timeout = 0');
  h.db.$client.pragma('journal_mode = DELETE');
  lock.exec('BEGIN EXCLUSIVE');
  h.store.getWriteIntent = (...args) => {
    try {
      return reader(...args);
    } catch (error) {
      lock.exec('ROLLBACK');
      throw error;
    }
  };
  try {
    await expect(h.service.recover(original.intentId)).rejects.toThrow();
    expect(h.row()).toEqual(original);
  } finally {
    if (lock.inTransaction) lock.exec('ROLLBACK');
    lock.close();
    h.store.getWriteIntent = reader;
  }
});

it('ignores a replaced public method that attempts to rewrite the original frozen approval', async () => {
  const h = await fixture();
  const input = await h.request(),
    before = await readFile(h.path);
  const originalGrant = h.store.getGrant(h.grantId);
  let calls = 0;
  h.authority.requireCurrent = (_request, _actor, approved) => {
    calls++;
    approved.grantRevision++;
    return approved;
  };
  const receipt = await h.service.toggle(input, h.actor);
  expect(calls).toBe(0);
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: input.eventId } });
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  expect([...bytes].filter((value, index) => value !== before[index])).toHaveLength(1);
  expect(bytes).toEqual(Buffer.from('\ufeff- [x] café😀\r\n- [ ] repeated\r\n'));
  expect(h.row()).toMatchObject({
    eventId: input.eventId,
    grantId: h.grantId,
    status: 'committed',
  });
  expect(h.service.validate(h.row()).authority.grantRevision).toBe(1);
  expect(h.store.getGrant(h.grantId)).toEqual(originalGrant);
  expect(h.service.fenced(h.path)).toBe(false);
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
  expect(h.service.validate(h.row()).receipt).toEqual(receipt);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect(await readFile(h.path)).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
});
