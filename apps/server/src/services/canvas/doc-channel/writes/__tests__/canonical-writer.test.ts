import {
  mkdtemp,
  writeFile,
  realpath,
  stat,
  symlink,
  link,
  unlink,
  rm,
  readFile,
} from 'node:fs/promises';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentityChangedError,
  type CanonicalWriteLease,
} from '../canonical-writer.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(onResolve?: () => void, assertBoundary?: () => void) {
  const dir = await mkdtemp(join(tmpdir(), 'canonical-writer-'));
  dirs.push(dir);
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  await writeFile(a, 'a');
  await writeFile(b, 'b');
  let transaction = false;
  const coordinator = new CanonicalFileWriteCoordinator({
    assertOutsideTransaction() {
      if (transaction) throw new Error('transaction');
      assertBoundary?.();
    },
    async resolve(path) {
      const canonicalPath = await realpath(path);
      const info = await stat(canonicalPath, { bigint: true });
      if (!info.isFile()) throw new Error('not regular');
      onResolve?.();
      return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
    },
  });
  return {
    dir,
    a,
    b,
    coordinator,
    setTransaction(value: boolean) {
      transaction = value;
    },
  };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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

it('keeps actual filesystem lookup errors distinct from pre-callback identity changes', async () => {
  const f = await fixture();
  await unlink(f.a);
  const operation = f.coordinator.withFiles([f.a], async () => undefined);
  await expect(operation).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(operation).rejects.not.toBeInstanceOf(CanonicalFileIdentityChangedError);
});

async function actualIdentity(path: string) {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath, { bigint: true });
  return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

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

it('preserves concurrency of unrelated active filesystem effects', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  const first = f.coordinator.withFiles([f.a], async () => {
    entered.release();
    await held.promise;
  });
  await entered.promise;
  try {
    await f.coordinator.withFiles([f.b], async () => {
      await writeFile(f.b, 'unrelated');
    });
    expect(await readFile(f.b, 'utf8')).toBe('unrelated');
  } finally {
    held.release();
    await first;
  }
});
