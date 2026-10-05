/** Genuine current authority and fixed host completion across physical/SQLite boundaries. */
import { readFile, stat, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { canvasDocWriteIntents, user } from '@dorkos/db';
import { rawByteHash, prepareCheckboxBytes } from '../checkbox-bytes.js';
import { observedCheckboxIntent } from '../checkbox-evidence.js';
import { CheckboxWriteFencedError } from '../checkbox-fence.js';
import { DocCheckboxWriteService } from '../checkbox-service.js';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './checkbox-fixture.js';
import { quarantineCheckboxIntent } from '../write-recovery.js';

const sourceReadHold = vi.hoisted(() => ({
  path: '',
  armed: false,
  afterStop: false,
  lateReads: 0,
  entered: () => {},
  released: Promise.resolve(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (sourceReadHold.afterStop) sourceReadHold.lateReads++;
      const result = await actual.lstat(...args);
      if (sourceReadHold.armed && String(args[0]) === sourceReadHold.path) {
        sourceReadHold.armed = false;
        sourceReadHold.entered();
        await sourceReadHold.released;
      }
      return result;
    },
  };
});
function holdSourceRead(path: string) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  sourceReadHold.released = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(sourceReadHold, { path, armed: true, entered: enter });
  return {
    entered,
    release: () => {
      sourceReadHold.armed = false;
      release();
    },
  };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  sourceReadHold.afterStop = false;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const h = await fixture(options);
  cleanups.push(h.cleanup);
  return h;
}
it('preserves the genuine original approval and UUID through a reached partial outbox rollback and FILE reopen', async () => {
  const h = await setup();
  const input = await h.request();
  const originalGrant = h.store.getGrant(h.grantId)!;
  const before = await readFile(h.path);
  let partial: unknown;
  // This callback is a test-only SQLite UDF invoked by the real delivery INSERT, after event and batch INSERTs.
  h.db.$client.function('capture_physical_outbox', (events, batches) => {
    partial = { events: { n: events }, batches: { n: batches } };
    return 1;
  });
  h.db.$client.exec(
    "CREATE TRIGGER capture_then_refuse BEFORE INSERT ON canvas_doc_deliveries BEGIN SELECT capture_physical_outbox((SELECT count(*) FROM canvas_doc_events),(SELECT count(*) FROM canvas_doc_batches)); SELECT RAISE(ABORT,'reached physical outbox'); END"
  );
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow('reached physical outbox');
  expect(partial).toEqual({ events: { n: 1 }, batches: { n: 1 } });
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  const row = h.row(),
    bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  expect(row).toMatchObject({
    documentId: h.documentId,
    eventId: input.eventId,
    grantId: h.grantId,
    status: 'replaced',
  });
  expect([...bytes].filter((value, index) => value !== before[index])).toHaveLength(1);
  h.db.$client.exec('DROP TRIGGER capture_then_refuse');
  await h.service.stop();
  h.db.$client.close();
  cleanups.pop();
  const reopened = await fixture({}, { dir: h.dir, documentId: h.documentId, grantId: h.grantId });
  cleanups.push(reopened.cleanup);
  expect(reopened.store.getGrant(h.grantId)).toEqual(originalGrant);
  expect(reopened.row()).toEqual(row);
  const receipt = await reopened.service.recover(row.intentId);
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: input.eventId } });
  expect(await reopened.service.toggle(input, reopened.actor)).toEqual(receipt);
  expect(await reopened.service.recover(row.intentId)).toEqual(receipt);
  expect((await stat(reopened.path)).ino).toBe(inode);
  expect(await readFile(reopened.path)).toEqual(bytes);
  expect(reopened.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  const frames = reopened.db.$client
    .prepare('SELECT type, event_id, doc_seq FROM canvas_doc_events ORDER BY doc_seq')
    .all();
  expect(frames).toEqual([
    { type: 'md.task.toggled', event_id: input.eventId, doc_seq: 1 },
    { type: 'event.status', event_id: expect.any(String), doc_seq: 2 },
  ]);
  expect(reopened.notices).toEqual([h.documentId]);
});
it('fixed no-op and conflict preserve terminal UUIDs without any changed event or outbox', async () => {
  const h = await setup();
  const noOp = await h.request(false),
    stale = { ...(await h.request()), expectedFileVersion: 'opaque-stale-version' };
  const first = await h.service.toggle(noOp, h.actor),
    second = await h.service.toggle(stale, h.actor);
  expect(first).toMatchObject({ status: 'no_op', eventId: noOp.eventId });
  expect(second).toEqual({ status: 'conflict', eventId: stale.eventId, action: 'reload' });
  expect(await h.service.toggle(noOp, h.actor)).toEqual(first);
  expect(await h.service.toggle({ ...noOp, done: true }, h.actor)).toEqual({
    status: 'conflict',
    eventId: noOp.eventId,
    action: 'reload',
  });
  expect(
    h.db.$client
      .prepare('SELECT event_id,status FROM canvas_doc_write_intents ORDER BY event_id')
      .all()
  ).toEqual(
    [
      { event_id: noOp.eventId, status: 'no_op' },
      { event_id: stale.eventId, status: 'conflict' },
    ].sort((a, b) => a.event_id.localeCompare(b.event_id))
  );
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(h.notices).toEqual([]);
});
it('fixed terminal full-row audit rolls back a post-insert trigger rewrite before a receipt escapes', async () => {
  const h = await setup();
  const bytes = await readFile(h.path);
  h.db.$client.exec(
    "CREATE TRIGGER rewrite_terminal AFTER INSERT ON canvas_doc_write_intents WHEN NEW.status='no_op' BEGIN UPDATE canvas_doc_write_intents SET updated_at='tampered' WHERE intent_id=NEW.intent_id; END"
  );
  await expect(h.service.toggle(await h.request(false), h.actor)).rejects.toThrow();
  expect(h.row()).toBeUndefined();
  expect(await readFile(h.path)).toEqual(bytes);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it('fixed staged full-row audit rolls back a trigger rewrite without a physical marker effect', async () => {
  const h = await setup();
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  h.db.$client.exec(
    "CREATE TRIGGER rewrite_staging AFTER UPDATE ON canvas_doc_write_intents WHEN NEW.status='prepared' AND json_extract(NEW.evidence,'$.tempIdentity') IS NOT NULL BEGIN UPDATE canvas_doc_write_intents SET canonical_path=canonical_path||'.other' WHERE intent_id=NEW.intent_id; END"
  );
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(await readFile(h.path)).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.row().canonicalPath).toBe(h.path);
  expect(h.service.fenced(h.path)).toBe(true);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it('lost current grant after prepared admission retains truthful uncertainty and does not terminalize or free the path', async () => {
  const h: Awaited<ReturnType<typeof setup>> = await setup({
    checkpoint: async (point) => {
      if (point === 'prepared') h.revoke();
    },
  });
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(await readFile(h.path)).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.row().status).toBe('prepared');
  expect(h.service.fenced(h.path)).toBe(true);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(h.notices).toEqual([]);
});
it('quarantine compares all retained evidence and rolls back a trigger mutation instead of laundering it', async () => {
  const h = await setup({
    checkpoint: async (point) => {
      if (point === 'prepared') throw new Error('held prepared');
    },
  });
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('held prepared');
  const original = h.row();
  h.db.$client.exec(
    "CREATE TRIGGER rewrite_quarantine AFTER UPDATE ON canvas_doc_write_intents WHEN NEW.status='in_doubt' BEGIN UPDATE canvas_doc_write_intents SET envelope_hash='" +
      'f'.repeat(64) +
      "' WHERE intent_id=NEW.intent_id; END"
  );
  expect(() =>
    quarantineCheckboxIntent(h.store, original, 'authority_unavailable', new Date().toISOString())
  ).toThrow();
  expect(h.row()).toEqual(original);
  expect(h.service.fenced(h.path)).toBe(true);
  h.db.$client.exec('DROP TRIGGER rewrite_quarantine');
  h.db.$client
    .prepare('UPDATE canvas_doc_write_intents SET event_id=? WHERE intent_id=?')
    .run(randomUUID(), original.intentId);
  const changed = h.row();
  expect(() =>
    quarantineCheckboxIntent(h.store, original, 'authority_unavailable', new Date().toISOString())
  ).toThrow();
  expect(h.row()).toEqual(changed);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
it('requires the private final effect gate even when a public method is replaced on the genuine authority', async () => {
  const h = await setup();
  const input = await h.request(),
    bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const refresh = h.authority.refreshCurrent.bind(h.authority);
  let refreshes = 0;
  h.authority.refreshCurrent = async (...args) => {
    const snapshot = await refresh(...args);
    if (++refreshes === 3) h.revoke();
    return snapshot;
  };
  h.authority.requireCurrent = () => h.approved;
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
  const after = await readFile(h.path);
  console.log('FINAL_EFFECT_WITNESS', {
    documentId: h.documentId,
    eventId: input.eventId,
    grantId: h.grantId,
    grantRevoked: h.store.getGrant(h.grantId)?.revokedAt !== null,
    bytesChanged: !after.equals(bytes),
    inodeChanged: (await stat(h.path)).ino !== inode,
    intentStatus: h.row().status,
    counts: h.counts(),
  });
  expect(after).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

for (const mutation of ['owned-row', 'corrupt-tail'] as const) {
  it(`refuses a second FILE connection ${mutation} mutation during a held real aggregate source read`, async () => {
    const h = await setup();
    h.failCompletion(true);
    await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow(
      'completion rollback'
    );
    h.failCompletion(false);
    const original = h.row(),
      before = await readFile(h.path),
      inode = (await stat(h.path)).ino;
    const held = holdSourceRead(h.dir),
      second = new Database(h.db.$client.name);
    const currentGate = vi.spyOn(h.authority, 'requireRecoveryCurrent');
    const operation = h.service.recover(original.intentId);
    void operation.catch(() => undefined);
    try {
      await held.entered;
      currentGate.mockClear();
      if (mutation === 'owned-row')
        second
          .prepare('UPDATE canvas_doc_write_intents SET updated_at=? WHERE intent_id=?')
          .run('2026-10-02T00:00:00.000Z', original.intentId);
      else {
        const input = { ...(original.input as object), eventId: randomUUID() };
        drizzle(second)
          .insert(canvasDocWriteIntents)
          .values({
            ...original,
            intentId: 'zz-corrupt-tail',
            eventId: input.eventId,
            input,
            envelopeHash: rawByteHash(Buffer.from(JSON.stringify(input))),
            evidence: {},
          })
          .run();
      }
      held.release();
      await expect(operation).rejects.toThrow();
      expect(currentGate.mock.calls.length).toBe(0);
      expect(await readFile(h.path)).toEqual(before);
      expect((await stat(h.path)).ino).toBe(inode);
      expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
      expect(h.store.getWriteIntent(original.intentId)?.eventId).toBe(original.eventId);
      if (mutation === 'owned-row') expect(h.row().updatedAt).toBe('2026-10-02T00:00:00.000Z');
    } finally {
      held.release();
      await operation.catch(() => undefined);
      second.close();
    }
  });
}
it('sees a genuinely separately approved alias observation inserted during a held source read', async () => {
  let decisionClockCalls = 0;
  const h = await setup({
      now: () => {
        decisionClockCalls++;
        return new Date();
      },
    }),
    aliasPath = join(h.dir, 'held-approved-alias.md');
  await link(h.path, aliasPath);
  const alias = await h.approveAlias(aliasPath);
  const bytes = await readFile(h.path),
    physical = await stat(h.path, { bigint: true });
  const input = { ...(await h.request()), documentId: alias.documentId };
  const approved = await alias.authority.prepare(input, h.actor);
  const freshAlias = await alias.authority.refreshCurrent(input, h.actor, approved);
  alias.authority.transaction((tx) =>
    alias.authority.requireCurrent(input, h.actor, approved, freshAlias, tx)
  );
  const originalGrant = h.store.getGrant(h.grantId),
    aliasGrant = h.store.getGrant(alias.grant.grantId);
  const observation = observedCheckboxIntent(
    input,
    approved,
    rawByteHash(Buffer.from(JSON.stringify(input))),
    new Date().toISOString(),
    rawByteHash(bytes),
    { device: String(physical.dev), inode: String(physical.ino) },
    prepareCheckboxBytes(bytes, input)
  ).intent;
  alias.service.validate(observation);
  const held = holdSourceRead(h.dir),
    second = new Database(h.db.$client.name);
  const originalInput = await h.request(),
    operation = h.service.toggle(originalInput, h.actor);
  void operation.catch(() => undefined);
  try {
    await held.entered;
    drizzle(second).insert(canvasDocWriteIntents).values(observation).run();
    expect(h.store.getWriteIntent(observation.intentId)).toEqual(observation);
    held.release();
    await expect(operation).rejects.toThrow(CheckboxWriteFencedError);
    expect(decisionClockCalls).toBe(0);
    expect(await readFile(h.path)).toEqual(bytes);
    expect(await readFile(aliasPath)).toEqual(bytes);
    expect((await stat(h.path, { bigint: true })).ino).toBe(physical.ino);
    expect(h.store.getGrant(h.grantId)).toEqual(originalGrant);
    expect(h.store.getGrant(alias.grant.grantId)).toEqual(aliasGrant);
    expect(h.store.getWriteIntent(observation.intentId)?.eventId).toBe(input.eventId);
    expect(h.service.find(h.documentId, originalInput.eventId)).toBeUndefined();
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  } finally {
    held.release();
    await operation.catch(() => undefined);
    second.close();
    await alias.service.stop();
  }
});
it('stop drains a held real source read before disposal and a fresh service recovers the original once', async () => {
  const h = await setup();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('completion rollback');
  h.failCompletion(false);
  const original = h.row(),
    bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const held = holdSourceRead(h.dir),
    operation = h.service.recover(original.intentId);
  void operation.catch(() => undefined);
  await held.entered;
  let drained = false;
  const stopped = h.service.stop().then(() => {
    drained = true;
  });
  try {
    await Promise.resolve();
    expect(drained).toBe(false);
    sourceReadHold.afterStop = true;
    sourceReadHold.lateReads = 0;
    held.release();
    await expect(operation).rejects.toThrow('not available');
    await stopped;
    expect(sourceReadHold.lateReads).toBe(0);
    sourceReadHold.afterStop = false;
    expect(h.row()).toEqual(original);
    expect(await readFile(h.path)).toEqual(bytes);
    expect((await stat(h.path)).ino).toBe(inode);
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  } finally {
    held.release();
    await operation.catch(() => undefined);
    await stopped;
    sourceReadHold.afterStop = false;
  }
  h.db.$client.close();
  cleanups.pop();
  const reopened = await fixture({}, { dir: h.dir, documentId: h.documentId, grantId: h.grantId });
  cleanups.push(reopened.cleanup);
  const receipt = await reopened.service.recover(original.intentId);
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: original.eventId } });
  expect(await reopened.service.recover(original.intentId)).toEqual(receipt);
  expect(reopened.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await readFile(reopened.path)).toEqual(bytes);
  expect((await stat(reopened.path)).ino).toBe(inode);
});

// Proposed append to the existing genuine production-recovery test file. UNRUN.
// Uses existing setup/cleanups, real FILE database, consumed approval and original UUID.
it('rejects before rename when the final public transaction wrapper skips a revoked original gate', async () => {
  const h = await setup();
  const input = await h.request();
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const run = h.authority.transaction.bind(h.authority);
  const refresh = h.authority.refreshCurrent.bind(h.authority);
  let calls = 0,
    refreshes = 0;
  h.authority.refreshCurrent = async (...args) => {
    const snapshot = await refresh(...args);
    if (++refreshes === 3) {
      h.revoke();
      h.authority.transaction = (() => {
        calls++;
        return undefined;
      }) as typeof h.authority.transaction;
    }
    return snapshot;
  };
  try {
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(await readFile(h.path)).toEqual(bytes);
    expect((await stat(h.path)).ino).toBe(inode);
    expect(h.row().eventId).toBe(input.eventId);
    expect(h.row().status).not.toBe('committed');
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
    expect(h.store.getGrant(h.grantId)!.revokedAt).not.toBeNull();
    expect(calls).toBe(0);
  } finally {
    h.authority.transaction = run;
  }
});
it('runs the final gate without an after-callback public wrapper', async () => {
  const h: Awaited<ReturnType<typeof setup>> = await setup({
    checkpoint: async (point) => {
      if (point === 'replaced') h.authority.transaction = run;
    },
  });
  const input = await h.request();
  const before = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const run = h.authority.transaction.bind(h.authority);
  const refresh = h.authority.refreshCurrent.bind(h.authority);
  let calls = 0,
    refreshes = 0;
  h.authority.refreshCurrent = async (...args) => {
    const snapshot = await refresh(...args);
    if (++refreshes === 3)
      h.authority.transaction = (work) =>
        run((tx) => {
          calls++;
          const result = work(tx);
          h.revoke();
          return result;
        });
    return snapshot;
  };
  try {
    const receipt = await h.service.toggle(input, h.actor);
    expect(receipt.status).toBe('changed');
    expect(calls).toBe(0);
    expect(h.store.getGrant(h.grantId)!.revokedAt).toBeNull();
    expect(h.store.getGrant(h.grantId)!.revision).toBe(1);
    expect(await readFile(h.path)).toEqual(Buffer.from('\ufeff- [x] café😀\r\n- [ ] repeated\r\n'));
    expect((await stat(h.path)).ino).not.toBe(inode);
    expect(await readFile(h.path)).not.toEqual(before);
    expect(h.row().eventId).toBe(input.eventId);
    expect(h.row().status).toBe('committed');
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  } finally {
    h.authority.transaction = run;
  }
});
for (const mode of ['skip', 'after-callback'] as const) {
  it(`completes with the captured runner despite a ${mode} public transaction wrapper`, async () => {
    let armed = false;
    const h = await setup({
      checkpoint: async (point) => {
        if (point === 'verified') armed = true;
      },
    });
    const input = await h.request();
    const run = h.authority.transaction.bind(h.authority);
    const refresh = h.authority.refreshCurrent.bind(h.authority);
    let calls = 0;
    h.authority.refreshCurrent = async (...args) => {
      const snapshot = await refresh(...args);
      if (armed) {
        armed = false;
        h.authority.transaction = (
          mode === 'skip'
            ? () => {
                calls++;
                return undefined;
              }
            : (work: Parameters<typeof run>[0]) =>
                run((tx) => {
                  calls++;
                  const result = work(tx);
                  h.revoke();
                  return result;
                })
        ) as typeof h.authority.transaction;
      }
      return snapshot;
    };
    try {
      const receipt = await h.service.toggle(input, h.actor);
      expect(receipt.status).toBe('changed');
      expect(calls).toBe(0);
      expect(h.row().eventId).toBe(input.eventId);
      expect(h.row().status).toBe('committed');
      expect(h.store.getGrant(h.grantId)!.revokedAt).toBeNull();
      expect(h.store.getGrant(h.grantId)!.revision).toBe(1);
      expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
      const bytes = await readFile(h.path),
        inode = (await stat(h.path)).ino;
      expect(bytes).toEqual(Buffer.from('\ufeff- [x] café😀\r\n- [ ] repeated\r\n'));
      h.authority.transaction = run;
      expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
      expect(await readFile(h.path)).toEqual(bytes);
      expect((await stat(h.path)).ino).toBe(inode);
      expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
    } finally {
      h.authority.transaction = run;
    }
  });
}

// Proposed existing-test import delta: add `user` to its @dorkos/db import.
it('refuses duplicate disclosure through private current access after actual installation-owner loss', async () => {
  const h = await setup();
  const input = await h.request();
  const receipt = await h.service.toggle(input, h.actor);
  const row = structuredClone(h.row());
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  h.db
    .insert(user)
    .values({
      id: 'new-current-owner',
      name: 'New',
      email: 'new@example.test',
      updatedAt: new Date(),
    })
    .run();
  const run = h.authority.transaction.bind(h.authority);
  const access = h.authority.requireAccess.bind(h.authority);
  const preflight = h.authority.preflight.bind(h.authority);
  h.authority.transaction = (() => undefined) as typeof h.authority.transaction;
  h.authority.requireAccess = () => undefined;
  h.authority.preflight = async () => undefined;
  try {
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(h.row()).toEqual(row);
    expect(await readFile(h.path)).toEqual(bytes);
    expect((await stat(h.path)).ino).toBe(inode);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
    expect(receipt.status).toBe('changed');
  } finally {
    h.authority.transaction = run;
    h.authority.requireAccess = access;
    h.authority.preflight = preflight;
  }
});

// Additional proposed controls ONLY. UNRUN, not yet authorized for repository append.
// Uses actual existing fixture, SAME migrated FILE SQLite, original consumed approval.
it('refuses duplicate disclosure when the observable public row read changes the actual owner', async () => {
  const h = await setup();
  const input = await h.request();
  await h.service.toggle(input, h.actor);
  const row = structuredClone(h.row());
  const getter = h.store.getWriteIntent.bind(h.store);
  const access = h.authority.requireAccess.bind(h.authority);
  let changed = false;
  h.store.getWriteIntent = (id, tx) => {
    const actual = getter(id, tx);
    if (!changed && id === row.intentId) {
      changed = true;
      h.db
        .insert(user)
        .values({
          id: 'changed-after-read',
          name: 'New',
          email: 'new@example.test',
          updatedAt: new Date(),
        })
        .run();
    }
    return actual;
  };
  h.authority.requireAccess = () => undefined;
  try {
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(changed).toBe(true);
    expect(getter(row.intentId)).toEqual(row);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  } finally {
    h.store.getWriteIntent = getter;
    h.authority.requireAccess = access;
  }
});
it('uses the actual SQL receipt rather than a valid forged public store DTO', async () => {
  const h = await setup();
  const input = await h.request();
  const receipt = await h.service.toggle(input, h.actor);
  const row = structuredClone(h.row());
  const fake = structuredClone(row);
  const evidence = h.service.validate(fake);
  if (evidence.receipt?.status !== 'changed') throw new Error('Genuine changed receipt expected');
  evidence.receipt.receipt.docSeq += 100;
  fake.evidence = evidence;
  h.service.validate(fake); // valid structurally; the only defect is it is not the actual SQL row.
  const getter = h.store.getWriteIntent.bind(h.store);
  h.store.getWriteIntent = (id, tx) => (id === row.intentId ? fake : getter(id, tx));
  try {
    expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
    expect(getter(row.intentId)).toEqual(row);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  } finally {
    h.store.getWriteIntent = getter;
  }
});

it('requires the service constructor database to own its genuine store before any operation', async () => {
  const owning = await setup(),
    foreign = await setup();
  expect(owning.db.$client.prepare('PRAGMA database_list').all()).not.toEqual(
    foreign.db.$client.prepare('PRAGMA database_list').all()
  );
  const request = await owning.request();
  const before = await readFile(owning.path),
    inode = (await stat(owning.path)).ino;
  const grant = owning.store.getGrant(owning.grantId);
  expect(
    () =>
      new DocCheckboxWriteService(
        foreign.db,
        owning.store,
        owning.coordinator,
        owning.authority,
        owning.delivery
      )
  ).toThrow('Checkbox authority requires its genuine store transaction database.');
  expect(owning.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(foreign.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(owning.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(foreign.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(owning.store.getGrant(owning.grantId)).toEqual(grant);
  expect(await readFile(owning.path)).toEqual(before);
  expect((await stat(owning.path)).ino).toBe(inode);
  expect(owning.notices).toEqual([]);
  const receipt = await owning.service.toggle(request, owning.actor);
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: request.eventId } });
  expect(await owning.service.toggle(request, owning.actor)).toEqual(receipt);
  expect(owning.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(owning.row()).toMatchObject({ eventId: request.eventId, status: 'committed' });
});

it('checks service constructor database provenance before reading delivery configuration', async () => {
  const owning = await setup(),
    foreign = await setup();
  let reads = 0;
  const delivery = {
    get policyLimits() {
      reads++;
      return owning.delivery.policyLimits;
    },
    get notifyCommitted() {
      reads++;
      return owning.delivery.notifyCommitted;
    },
  };
  let failure: unknown;
  try {
    new DocCheckboxWriteService(
      foreign.db,
      owning.store,
      owning.coordinator,
      owning.authority,
      delivery
    );
  } catch (error) {
    failure = error;
  }
  expect(reads).toBe(0);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: 'Checkbox authority requires its genuine store transaction database.',
  });
  expect(owning.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(owning.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(owning.notices).toEqual([]);
});
