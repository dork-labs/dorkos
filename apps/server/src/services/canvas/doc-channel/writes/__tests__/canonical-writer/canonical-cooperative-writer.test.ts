import { fixture, latch } from './harness.js';
import { writeFile, stat, symlink, link, readFile } from 'node:fs/promises';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanonicalFileIdentityChangedError } from '../../canonical-writer.js';
import Database from 'better-sqlite3';

describe('canonical cooperative writer', () => {
  it('serializes symlink and hardlink aliases and preserves FIFO', async () => {
    const f = await fixture();
    const alias = join(f.dir, 'alias');
    const hard = join(f.dir, 'hard');
    await symlink(f.a, alias);
    await link(f.a, hard);
    const held = latch();
    const entered = latch();
    const order: number[] = [];
    const first = f.coordinator.withFiles([f.a], async () => {
      order.push(1);
      entered.release();
      await held.promise;
    });
    await entered.promise;
    const second = f.coordinator.withFiles([alias], async () => {
      order.push(2);
    });
    const third = f.coordinator.withFiles([hard], async () => {
      order.push(3);
    });
    held.release();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });
  it('orders reversed multiple keys without deadlock and cleans callback errors', async () => {
    const f = await fixture();
    await Promise.all([
      f.coordinator.withFiles([f.a, f.b], async () => undefined),
      f.coordinator.withFiles([f.b, f.a], async () => undefined),
    ]);
    await expect(
      f.coordinator.withFiles([f.a], async () => {
        throw new Error('write');
      })
    ).rejects.toThrow('write');
    await f.coordinator.withFiles([f.a], async () => undefined);
  });
  it('re-resolves after waiting and refuses replacement instead of writing wrong identity', async () => {
    const held = latch();
    const entered = latch();
    const resolving = latch();
    let resolutions = 0;
    const f = await fixture(() => {
      if (++resolutions === 3) resolving.release();
    });
    const first = f.coordinator.withFiles([f.a], async () => {
      entered.release();
      await held.promise;
    });
    await entered.promise;
    let writes = 0;
    const second = f.coordinator.withFiles([f.a], async () => {
      writes++;
    });
    await resolving.promise;
    const replacement = f.a + '.replacement';
    await writeFile(replacement, 'replacement');
    expect((await stat(replacement, { bigint: true })).ino).not.toBe(
      (await stat(f.a, { bigint: true })).ino
    );
    await rename(replacement, f.a);
    held.release();
    await first;
    await expect(second).rejects.toBeInstanceOf(CanonicalFileIdentityChangedError);
    await expect(second).rejects.toThrow('identity changed');
    expect(writes).toBe(0);
  });
  it('rejects recursive acquisition and transaction use without leaking locks', async () => {
    const f = await fixture();
    await expect(
      f.coordinator.withFiles([f.a], async () =>
        f.coordinator.withFiles([f.b], async () => undefined)
      )
    ).rejects.toThrow('Recursive');
    f.setTransaction(true);
    await expect(f.coordinator.withFiles([f.a], async () => undefined)).rejects.toThrow(
      'transaction'
    );
    f.setTransaction(false);
    await f.coordinator.withFiles([f.a], async () => undefined);
  });

  it('refuses a real raw SQLite transaction opened while resolving', async () => {
    const db = new Database(':memory:');
    let begin = true;
    const f = await fixture(
      () => {
        if (begin) {
          begin = false;
          db.exec('BEGIN');
        }
      },
      () => {
        if (db.inTransaction) throw new Error('SQLite boundary');
      }
    );
    try {
      await expect(f.coordinator.withFiles([f.a], async () => undefined)).rejects.toThrow(
        'SQLite boundary'
      );
      db.exec('ROLLBACK');
      await f.coordinator.withFiles([f.a], async () => undefined);
    } finally {
      db.close();
    }
  });
  it('holds canonical pathname ownership through atomic replacement and verification', async () => {
    const held = latch();
    const renamed = latch();
    const queued = latch();
    let resolutions = 0;
    const f = await fixture(() => {
      if (++resolutions === 3) queued.release();
    });
    const first = f.coordinator.withFiles([f.a], async () => {
      const replacement = join(f.dir, 'replacement');
      await writeFile(replacement, 'new bytes');
      await rename(replacement, f.a);
      renamed.release();
      await held.promise;
    });
    await renamed.promise;
    let writes = 0;
    const second = f.coordinator.withFiles([f.a], async () => {
      writes++;
    });
    try {
      await queued.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(writes).toBe(0);
    } finally {
      held.release();
      await Promise.all([first, second]);
    }
    expect(writes).toBe(1);
  });
});

it('holds the replacement inode against new hard-link aliases through verification', async () => {
  const f = await fixture(),
    held = latch(),
    renamed = latch();
  const alias = join(f.dir, 'new-alias');
  let writes = 0;
  let bytes = '';
  const first = f.coordinator.withFiles([f.a], async (_identities, lease) => {
    const temp = join(f.dir, 'temp');
    await writeFile(temp, 'new');
    await lease.reserveReplacement(temp);
    await rename(temp, f.a);
    renamed.release();
    await held.promise;
    bytes = await readFile(f.a, 'utf8');
  });
  await renamed.promise;
  await link(f.a, alias);
  const second = f.coordinator.withFiles([alias], async () => {
    writes++;
    await writeFile(alias, 'alias changed');
  });
  try {
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(writes).toBe(0);
  } finally {
    held.release();
    await Promise.all([first, second]);
  }
  expect(bytes).toBe('new');
  expect(writes).toBe(1);
});

it('reserves every overlapping key before waiting, preserving multi-key arrival FIFO', async () => {
  const held = latch(),
    entered = latch(),
    multiResolved = latch();
  let calls = 0;
  const order: string[] = [];
  const f = await fixture(() => {
    if (++calls === 4) multiResolved.release();
  });
  const paths = await Promise.all(
    [f.a, f.b].map(async (path) => {
      const info = await stat(path);
      return { path, lockKey: JSON.stringify([String(info.dev), String(info.ino)]) };
    })
  );
  paths.sort((left, right) => (left.lockKey < right.lockKey ? -1 : 1));
  const holder = f.coordinator.withFiles([paths[0]!.path], async () => {
    entered.release();
    await held.promise;
  });
  await entered.promise;
  const earlier = f.coordinator.withFiles([f.a, f.b], async () => {
    order.push('earlier');
  });
  await multiResolved.promise;
  const later = f.coordinator.withFiles([paths[1]!.path], async () => {
    order.push('later');
  });
  try {
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(order).toEqual([]);
  } finally {
    held.release();
    await Promise.all([holder, earlier, later]);
  }
  expect(order).toEqual(['earlier', 'later']);
});

it('refuses a held replacement without deadlock and releases all keys after callback failure', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  const holder = f.coordinator.withFiles([f.b], async () => {
    entered.release();
    await held.promise;
  });
  await entered.promise;
  try {
    await expect(
      f.coordinator.withFiles([f.a], async (_ids, lease) => {
        await lease.reserveReplacement(f.b);
      })
    ).rejects.toThrow('held or queued');
  } finally {
    held.release();
    await holder;
  }
  const replacement = join(f.dir, 'reserved');
  await writeFile(replacement, 'fresh');
  await expect(
    f.coordinator.withFiles([f.a], async (_ids, lease) => {
      await lease.reserveReplacement(replacement);
      throw new Error('cancelled');
    })
  ).rejects.toThrow('cancelled');
  await f.coordinator.withFiles([replacement], async () => undefined);
});
