/**
 * Concurrency is the reproduction for DOR-697. Every test here fires N writes
 * simultaneously at one destination; run sequentially they all pass against the
 * old fixed-temp-name code and would certify nothing.
 *
 * The two failure modes under test are different, and only one is loud:
 *
 * - **Step 4** — the loser's temp file was already renamed away, so its own
 *   rename throws `ENOENT` and the request 500s. Visible.
 * - **Step 3** — the winner renamed a temp file another writer had *overwritten*,
 *   publishing that writer's bytes under its own successful write. Returns 200.
 *   Only a content assertion can see it, so every test below asserts content.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pendingLockCount, withFileLock, writeFileAtomic } from '../atomic-write.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('writeFileAtomic', () => {
  it('creates missing parent directories', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'deep', 'nested', 'data.json');

    await writeFileAtomic(target, '{"ok":true}');

    expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual({ ok: true });
  });

  it('applies and re-asserts the requested mode over a pre-existing file', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeTempDir();
    const target = path.join(dir, 'secrets.json');

    // A pre-existing world-readable file: its permissions survive `rename`, so
    // the mode has to be re-asserted after the rename, not only at create time.
    await fs.writeFile(target, 'old', { mode: 0o644 });
    await writeFileAtomic(target, 'new', { mode: 0o600 });

    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp files behind', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'data.json');

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeFileAtomic(target, JSON.stringify({ i })))
    );

    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('removes its temp file when the write fails', async () => {
    const dir = await makeTempDir();
    // A directory where a file is expected: `rename` cannot replace it.
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    await expect(writeFileAtomic(target, 'nope')).rejects.toThrow();

    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  describe('concurrent writes to one destination', () => {
    it('N simultaneous writes all succeed — no ENOENT from a clobbered temp file', async () => {
      const dir = await makeTempDir();
      const target = path.join(dir, 'data.json');
      const N = 40;

      const results = await Promise.allSettled(
        Array.from({ length: N }, (_, i) => writeFileAtomic(target, JSON.stringify({ writer: i })))
      );

      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toEqual([]);
    });

    it('the surviving file is exactly one writer payload, never a blend', async () => {
      const dir = await makeTempDir();
      const target = path.join(dir, 'data.json');
      const N = 40;

      // Payloads differ in length so a torn write cannot accidentally parse.
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          writeFileAtomic(target, JSON.stringify({ writer: i, pad: 'x'.repeat(i * 64) }))
        )
      );

      const raw = await fs.readFile(target, 'utf-8');
      const parsed = JSON.parse(raw) as { writer: number; pad: string };
      expect(parsed.pad).toBe('x'.repeat(parsed.writer * 64));
    });

    it('two writers never cross: a completed write is observable as a whole', async () => {
      // The step-3 shape, at the size a person actually hits it: two cockpit
      // tabs saving the same target. Under the old code ~88% of these trials
      // published the other tab's bytes under a successful write.
      const dir = await makeTempDir();
      const TRIALS = 200;
      let crossed = 0;

      for (let t = 0; t < TRIALS; t++) {
        const target = path.join(dir, `t${t}.json`);
        // Sequence the two writers so the second is strictly last: with the
        // path lock, last-enqueued is last-written, so B's bytes must land.
        const a = writeFileAtomic(target, JSON.stringify({ tab: 'A' }));
        const b = writeFileAtomic(target, JSON.stringify({ tab: 'B' }));
        await Promise.all([a, b]);

        const final = JSON.parse(await fs.readFile(target, 'utf-8')) as { tab: string };
        if (final.tab !== 'B') crossed++;
      }

      expect(crossed).toBe(0);
    });

    it('a writer outside the lock cannot hijack an in-flight write', async () => {
      // The path lock only reaches writers inside this process. The unique temp
      // name is what protects the rest: a second process (or any call site that
      // has not been routed through this module) writing the legacy fixed temp
      // path must not be able to get its bytes renamed into our destination.
      const dir = await makeTempDir();
      const TRIALS = 100;
      let hijacked = 0;

      for (let t = 0; t < TRIALS; t++) {
        const target = path.join(dir, `t${t}.json`);
        const legacyTemp = `${target}.tmp`;

        const ours = writeFileAtomic(target, JSON.stringify({ owner: 'lock' }));
        const foreign = fs.writeFile(legacyTemp, JSON.stringify({ owner: 'foreign' }));
        await Promise.all([ours, foreign]);

        const final = JSON.parse(await fs.readFile(target, 'utf-8')) as { owner: string };
        if (final.owner !== 'lock') hijacked++;
        await fs.rm(legacyTemp, { force: true });
      }

      expect(hijacked).toBe(0);
    });

    it('writes to different paths are not serialised against each other', async () => {
      const dir = await makeTempDir();
      let inFlight = 0;
      let maxInFlight = 0;

      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          withFileLock(path.join(dir, `f${i}.json`), async (write) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            await write('{}');
            inFlight--;
          })
        )
      );

      expect(maxInFlight).toBeGreaterThan(1);
    });
  });
});

describe('withFileLock', () => {
  it('serialises read-modify-write so no update is lost', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'counter.json');
    await fs.writeFile(target, JSON.stringify({ keys: [] as string[] }));
    const N = 30;

    // Each writer reads, appends its own key, and writes back. Without the lock
    // every writer reads the same starting state and only one key survives.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withFileLock(target, async (write) => {
          const current = JSON.parse(await fs.readFile(target, 'utf-8')) as { keys: string[] };
          current.keys.push(`key-${i}`);
          await write(JSON.stringify(current));
        })
      )
    );

    const final = JSON.parse(await fs.readFile(target, 'utf-8')) as { keys: string[] };
    expect(final.keys).toHaveLength(N);
  });

  it('never runs two critical sections for one path at the same time', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'data.json');
    let inside = 0;
    let overlaps = 0;

    await Promise.all(
      Array.from({ length: 25 }, () =>
        withFileLock(target, async (write) => {
          inside++;
          if (inside > 1) overlaps++;
          await new Promise((r) => setTimeout(r, 1));
          await write('{}');
          inside--;
        })
      )
    );

    expect(overlaps).toBe(0);
  });

  it('throws on re-entry for a held path instead of deadlocking', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'data.json');

    // A nested acquisition on the same path would queue behind its own caller
    // forever. The guard turns that silent hang into an immediate error.
    await expect(
      withFileLock(target, async () => {
        await withFileLock(target, async () => 'inner');
        return 'outer';
      })
    ).rejects.toThrow(/Re-entrant withFileLock/);

    // And the outer failure released the path for the next writer.
    await expect(writeFileAtomic(target, '{"after":true}')).resolves.toBeUndefined();
  });

  it('nested writeFileAtomic on the held path is caught by the same guard', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'data.json');

    await expect(
      withFileLock(target, async () => {
        // The pre-fix behaviour was an unbounded await on our own queue.
        await writeFileAtomic(target, '{"nested":true}');
      })
    ).rejects.toThrow(/Re-entrant withFileLock/);
  });

  it('releases the path when the critical section throws', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'data.json');

    await expect(
      withFileLock(target, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // A thrown holder must not wedge the path for everyone behind it.
    await expect(writeFileAtomic(target, '{"after":true}')).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual({ after: true });
  });

  it('a failed writer does not poison the writers queued behind it', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'data.json');

    const results = await Promise.allSettled([
      withFileLock(target, async () => {
        throw new Error('first fails');
      }),
      withFileLock(target, (write) => write('{"second":true}')),
      withFileLock(target, (write) => write('{"third":true}')),
    ]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual({ third: true });
  });

  it('does not retain lock entries once paths drain', async () => {
    const dir = await makeTempDir();
    const before = pendingLockCount();

    // Keying by path must not leak: paths are per-extension and per-session, so
    // a retained entry per path would grow without bound over a long uptime.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => writeFileAtomic(path.join(dir, `f${i}.json`), '{}'))
    );
    // Including a path that failed — its entry must be released too.
    await expect(
      withFileLock(path.join(dir, 'boom.json'), async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow();

    expect(pendingLockCount()).toBe(before);
  });
});
