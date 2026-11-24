import { fixture, latch, actualIdentity, nextTurn } from './harness.js';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CanonicalFileWriteCoordinator, type CanonicalWriteLease } from '../../canonical-writer.js';

it('bounds reservations, rejects retired leases and recursive aliases, preserving unrelated concurrency', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  let retired!: CanonicalWriteLease;
  const first = f.coordinator.withFiles([f.a], async (_ids, lease) => {
    retired = lease;
    for (let i = 0; i < 16; i++) await lease.reserveReplacement(f.a);
    await expect(lease.reserveReplacement(f.a)).rejects.toThrow('limit');
    await expect(f.coordinator.withFiles([f.a], async () => undefined)).rejects.toThrow(
      'Recursive'
    );
    entered.release();
    await held.promise;
  });
  await entered.promise;
  let unrelated = false;
  try {
    await f.coordinator.withFiles([f.b], async () => {
      unrelated = true;
    });
    expect(unrelated).toBe(true);
  } finally {
    held.release();
    await first;
  }
  await expect(retired.reserveReplacement(f.a)).rejects.toThrow('no longer active');
});

it.each(['initial', 'fresh', 'sync'] as const)(
  'drains every launched %s identity probe before retiring the operation',
  async (phase) => {
    const f = await fixture();
    const held = latch(),
      entered = latch(),
      failed = latch();
    const failure = new Error('original resolver failure');
    const counts = new Map<string, number>();
    let live = 0,
      effects = 0,
      settled = false;
    const coordinator = new CanonicalFileWriteCoordinator({
      assertOutsideTransaction() {},
      resolve(path) {
        const n = (counts.get(path) ?? 0) + 1;
        counts.set(path, n);
        if (phase === 'fresh' && n === 1) return actualIdentity(path);
        if (path === f.a) {
          if (phase === 'sync') {
            failed.release();
            throw failure;
          }
          return (async () => {
            await unlink(path);
            try {
              await actualIdentity(path);
            } catch {
              failed.release();
              throw failure;
            }
            throw new Error('missing path unexpectedly resolved');
          })();
        }
        live++;
        entered.release();
        return held.promise
          .then(() => actualIdentity(path))
          .finally(() => {
            live--;
          });
      },
    });
    const operation = coordinator.withFiles([f.a, f.b], async () => {
      effects++;
    });
    const observed = operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await Promise.all([entered.promise, failed.promise]);
      await nextTurn();
      expect(live).toBe(1);
      expect(settled).toBe(false);
      expect(effects).toBe(0);
      let stopped = false;
      const stop = coordinator.stop().then(() => {
        stopped = true;
      });
      await nextTurn();
      expect(stopped).toBe(false);
      held.release();
      await stop;
      expect(live).toBe(0);
    } finally {
      held.release();
      await observed;
    }
    await expect(operation).rejects.toBe(failure);
    expect(live).toBe(0);
  }
);

it('keeps the 1024-operation admission bound while failing probes still drain', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  const failure = new Error('failed resolution');
  let live = 0,
    settled = 0;
  const coordinator = new CanonicalFileWriteCoordinator({
    assertOutsideTransaction() {},
    resolve(path) {
      if (path === f.a) return Promise.reject(failure);
      live++;
      entered.release();
      return held.promise
        .then(() => actualIdentity(path))
        .finally(() => {
          live--;
        });
    },
  });
  const operations = Array.from({ length: 1024 }, () =>
    coordinator
      .withFiles([f.a, f.b], async () => undefined)
      .then(
        () => {
          settled++;
        },
        () => {
          settled++;
        }
      )
  );
  try {
    await entered.promise;
    await nextTurn();
    await expect(coordinator.withFiles([f.a, f.b], async () => undefined)).rejects.toThrow(
      'queue is full'
    );
    expect(live).toBe(1);
    expect(settled).toBe(0);
  } finally {
    held.release();
    await Promise.all(operations);
  }
  expect(live).toBe(0);
  expect(settled).toBe(1024);
});

it('closes admission, cancels queued callbacks and drains active effects before stop settles', async () => {
  const queuedReady = latch();
  let resolutions = 0;
  const f = await fixture(() => {
      if (++resolutions === 3) queuedReady.release();
    }),
    entered = latch(),
    held = latch();
  let queuedEffects = 0,
    stopped = false;
  const active = f.coordinator.withFiles([f.a], async () => {
    entered.release();
    await held.promise;
    await writeFile(f.a, 'completed active effect');
  });
  await entered.promise;
  const queued = f.coordinator.withFiles([f.a], async () => {
    queuedEffects++;
  });
  const queuedOutcome = queued.catch((error: unknown) => error);
  await queuedReady.promise;
  const stop = f.coordinator.stop().then(() => {
    stopped = true;
  });
  await nextTurn();
  expect(stopped).toBe(false);
  await expect(f.coordinator.withFiles([f.b], async () => undefined)).rejects.toThrow('closed');
  held.release();
  await Promise.all([active, stop]);
  expect(await queuedOutcome).toBeInstanceOf(Error);
  expect(queuedEffects).toBe(0);
  expect(await readFile(f.a, 'utf8')).toBe('completed active effect');
  await f.coordinator.stop();
});

it('refuses nested stop without closing admission or deadlocking the active callback', async () => {
  const f = await fixture();
  await f.coordinator.withFiles([f.a], async () => {
    await expect(f.coordinator.stop()).rejects.toThrow('Recursive');
    await expect(f.coordinator.withFiles([f.b], async () => undefined)).rejects.toThrow(
      'Recursive'
    );
  });
  await f.coordinator.withFiles([f.b], async () => undefined);
  await f.coordinator.stop();
});
