/**
 * Shared setup for the checkbox-production-recovery suites: everything the original file declared or
 * registered outside its tests.
 */
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { canvasDocWriteIntents } from '@dorkos/db';
import { rawByteHash } from '../checkbox-bytes.js';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './checkbox-fixture.js';

export const sourceReadHold = vi.hoisted(() => ({
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

export function holdSourceRead(path: string) {
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

export const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sourceReadHold.afterStop = false;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

export async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const h = await fixture(options);
  cleanups.push(h.cleanup);
  return h;
}

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
