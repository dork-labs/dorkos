import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LedgerObservation } from '@dorkos/shared/account-usage';
import {
  deleteLedger,
  ledgerDir,
  listLedgerFiles,
  readLedger,
  withLedgerLock,
  writeLedger,
} from '../ledger-file.js';
import { logger } from '../../../../lib/logger.js';

const NOW = new Date('2026-09-26T16:00:00.000Z');

function obs(key: string, usedPct: number, observedAt = '2026-09-26T15:59:00.000Z') {
  return { key, usedPct, observedAt, source: 'sdk_event' } as LedgerObservation;
}

let home: string;
let dir: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-file-'));
  dir = ledgerDir(home, 'claude-code');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe('writeLedger (contract §1.2 "Writing")', () => {
  it('writes a fresh ledger with the runtime from the path, folder 0700 and file 0600', async () => {
    const result = await writeLedger(dir, 'work', [obs('five_hour', 41.5)], NOW);
    expect(result).toMatchObject({ written: true, dropped: [] });
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'work.json'), 'utf8'));
    expect(onDisk).toMatchObject({
      v: 1,
      runtime: 'claude-code',
      accountId: 'work',
      updatedAt: NOW.toISOString(),
      windows: { five_hour: { usedPct: 41.5, source: 'sdk_event' } },
    });
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, 'work.json'))).mode & 0o777).toBe(0o600);
    // The lock is released.
    await expect(fs.access(path.join(dir, 'work.json.lock'))).rejects.toThrow();
  });

  it('refuses an account id that fails the pattern', async () => {
    await expect(writeLedger(dir, '../escape', [obs('five_hour', 1)], NOW)).rejects.toThrow(
      /not a valid account id/
    );
  });

  it('retries a held lock and then gives up without throwing', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'work.json.lock'), '1:held');
    const sleep = vi.fn<(ms: number) => void>();
    // Long enough that even a loaded machine gets past the first attempt and sleeps.
    const result = await writeLedger(dir, 'work', [obs('five_hour', 1)], NOW, {
      giveUpMs: 300,
      sleep: async (ms) => {
        sleep(ms);
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    expect(result).toMatchObject({ written: false, gaveUp: true });
    expect(sleep).toHaveBeenCalled();
    for (const [ms] of sleep.mock.calls) {
      expect(ms).toBeGreaterThanOrEqual(25);
      expect(ms).toBeLessThanOrEqual(100);
    }
    // The held lock is untouched.
    expect(await fs.readFile(path.join(dir, 'work.json.lock'), 'utf8')).toBe('1:held');
    await expect(fs.access(path.join(dir, 'work.json'))).rejects.toThrow();
  });

  it('breaks a stale lock by renaming it, never by deleting its original name', async () => {
    await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, 'work.json.lock');
    await fs.writeFile(lock, '1:stale');
    const old = new Date(Date.now() - 20_000);
    await fs.utimes(lock, old, old);
    const rename = vi.spyOn(fs, 'rename');
    const rm = vi.spyOn(fs, 'rm');

    const result = await writeLedger(dir, 'work', [obs('five_hour', 5)], NOW);

    expect(result.written).toBe(true);
    expect(rename.mock.calls[0]![0]).toBe(lock);
    expect(String(rename.mock.calls[0]![1])).toMatch(/work\.json\.lock\.stale-[0-9a-f]+$/);
    // The only delete of the lock's own name is our release, after our write.
    const lockDeletes = rm.mock.calls.filter(([p]) => p === lock);
    expect(lockDeletes).toHaveLength(1);
    expect(
      rm.mock.invocationCallOrder[rm.mock.calls.findIndex(([p]) => p === lock)]
    ).toBeGreaterThan(
      rename.mock.invocationCallOrder[
        rename.mock.calls.findIndex(([, to]) => String(to).endsWith('work.json'))
      ]!
    );
    expect((await fs.readdir(dir)).sort()).toEqual(['work.json']);
  });

  it('two breakers on one stale lock: the second finds a fresh token, restores it, and never takes the lock', async () => {
    await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, 'work.json.lock');
    await fs.writeFile(lock, '1:stale');
    const old = new Date(Date.now() - 20_000);
    await fs.utimes(lock, old, old);

    // Between this breaker reading the stale token and renaming, another breaker
    // already broke it and a third writer took a fresh lock.
    const realRename = fs.rename.bind(fs);
    const link = vi.spyOn(fs, 'link');
    let raced = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!raced && from === lock) {
        raced = true;
        await fs.writeFile(lock, '2:fresh');
      }
      return realRename(from, to);
    });

    const result = await writeLedger(dir, 'work', [obs('five_hour', 5)], NOW, {
      giveUpMs: 60,
    });

    expect(raced).toBe(true);
    expect(link).toHaveBeenCalledWith(expect.stringMatching(/\.stale-/), lock);
    // The fresh holder keeps the lock, so this writer never held it at the same time.
    expect(result).toMatchObject({ written: false, gaveUp: true });
    expect(await fs.readFile(lock, 'utf8')).toBe('2:fresh');
    expect((await fs.readdir(dir)).filter((n) => n.includes('.stale-'))).toEqual([]);
  });

  it('a stale lock replaced by a fresh one before its token is read is never broken', async () => {
    await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, 'work.json.lock');
    await fs.writeFile(lock, '1:stale');
    const old = new Date(Date.now() - 20_000);
    await fs.utimes(lock, old, old);

    // The first time this writer reads the lock's token, another breaker has
    // already broken the stale lock and a third writer holds a FRESH one. Had the
    // age been checked first, this writer would read the fresh token, move the
    // fresh lock, see its token match, and delete a live lock.
    const realReadFile = fs.readFile.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'readFile').mockImplementation((async (file: string, ...rest: unknown[]) => {
      if (!replaced && file === lock) {
        replaced = true;
        await fs.rm(lock);
        await fs.writeFile(lock, '2:fresh');
      }
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.readFile);

    const result = await writeLedger(dir, 'work', [obs('five_hour', 5)], NOW, { giveUpMs: 60 });

    expect(replaced).toBe(true);
    expect(result).toMatchObject({ written: false, gaveUp: true });
    expect(await realReadFile(lock, 'utf8')).toBe('2:fresh');
    expect((await fs.readdir(dir)).filter((n) => n.includes('.stale-'))).toEqual([]);
  });

  it('puts back a lock whose holder refreshed it between the token read and the rename', async () => {
    await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, 'work.json.lock');
    await fs.writeFile(lock, '1:slow-holder');
    const old = new Date(Date.now() - 20_000);
    await fs.utimes(lock, old, old);

    // Same token, but its holder touched it just before the breaker's rename:
    // the moved file is fresh, so it is a live lock and must go back.
    const realRename = fs.rename.bind(fs);
    const link = vi.spyOn(fs, 'link');
    let touched = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!touched && from === lock) {
        touched = true;
        const now = new Date();
        await fs.utimes(lock, now, now);
      }
      return realRename(from, to);
    });

    const result = await writeLedger(dir, 'work', [obs('five_hour', 5)], NOW, { giveUpMs: 60 });

    expect(touched).toBe(true);
    expect(link).toHaveBeenCalledWith(expect.stringMatching(/\.stale-/), lock);
    expect(result).toMatchObject({ written: false, gaveUp: true });
    expect(await fs.readFile(lock, 'utf8')).toBe('1:slow-holder');
  });

  it('never deletes a lock that now holds a foreign token on release', async () => {
    const lock = path.join(dir, 'work.json.lock');
    const result = await withLedgerLock(dir, 'work', async () => {
      await fs.writeFile(lock, '9:someone-else');
    });
    expect(result.gaveUp).toBe(false);
    expect(await fs.readFile(lock, 'utf8')).toBe('9:someone-else');
  });

  it('sets an unparsable file aside as .corrupt-<ms> and starts empty', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'work.json'), '{ not json');
    const result = await writeLedger(dir, 'work', [obs('five_hour', 7)], NOW);
    expect(result.written).toBe(true);
    const names = await fs.readdir(dir);
    expect(names.some((n) => /^work\.json\.corrupt-\d+$/.test(n))).toBe(true);
    expect((await readLedger(dir, 'work'))?.windows.five_hour?.usedPct).toBe(7);
  });

  it('sets aside valid JSON that is not a ledger, never overwriting it', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'work.json'), '{"hello":1}');
    const result = await writeLedger(dir, 'work', [obs('five_hour', 7)], NOW);
    expect(result.written).toBe(true);
    const corrupt = (await fs.readdir(dir)).find((n) => /^work\.json\.corrupt-\d+$/.test(n));
    expect(await fs.readFile(path.join(dir, corrupt!), 'utf8')).toBe('{"hello":1}');
  });

  it('leaves a ledger of another version alone', async () => {
    await fs.mkdir(dir, { recursive: true });
    const future = JSON.stringify({ v: 2, accountId: 'work', windows: {} });
    await fs.writeFile(path.join(dir, 'work.json'), future);
    const result = await writeLedger(dir, 'work', [obs('five_hour', 7)], NOW);
    expect(result.written).toBe(false);
    expect(await fs.readFile(path.join(dir, 'work.json'), 'utf8')).toBe(future);
  });

  it('does not rewrite the file when the merge changes nothing', async () => {
    await writeLedger(dir, 'work', [obs('five_hour', 7)], NOW);
    const rename = vi.spyOn(fs, 'rename');
    const again = await writeLedger(
      dir,
      'work',
      [obs('five_hour', 7)],
      new Date(NOW.getTime() + 1)
    );
    expect(again.written).toBe(false);
    expect(again.ledger?.windows.five_hour?.usedPct).toBe(7);
    expect(rename).not.toHaveBeenCalled();
  });

  it('keeps what another writer merged in between', async () => {
    await writeLedger(dir, 'work', [obs('five_hour', 7)], NOW);
    await writeLedger(dir, 'work', [obs('seven_day', 30)], NOW);
    const ledger = await readLedger(dir, 'work');
    expect(Object.keys(ledger!.windows).sort()).toEqual(['five_hour', 'seven_day']);
  });
});

describe('readLedger, deleteLedger, listLedgerFiles', () => {
  it('reads a missing ledger as null and an invalid one as null', async () => {
    expect(await readLedger(dir, 'work')).toBeNull();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'work.json'), '[]');
    expect(await readLedger(dir, 'work')).toBeNull();
  });

  describe('one entry it does not understand never blanks the file (DOR-2471)', () => {
    const good = { usedPct: 12, observedAt: '2026-09-26T15:59:00.000Z', source: 'sdk_event' };
    const plan = { name: 'pro', observedAt: '2026-09-26T15:59:00.000Z', source: 'rollout' };

    async function put(ledger: Record<string, unknown>): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'work.json'),
        JSON.stringify({
          v: 1,
          runtime: 'claude-code',
          accountId: 'work',
          updatedAt: '2026-09-26T15:59:00.000Z',
          ...ledger,
        })
      );
    }

    it('keeps every other window when one has a source it does not know', async () => {
      await put({
        windows: {
          five_hour: { ...good, source: 'a-future-source' },
          seven_day: good,
        },
      });
      const ledger = await readLedger(dir, 'work');
      expect(ledger?.windows).toEqual({ seven_day: { ...good, resetsAt: null, status: null } });
    });

    it('keeps the windows and the other facts when one fact is bad', async () => {
      await put({
        windows: { seven_day: good },
        plan,
        spend: {
          periodStart: '2026-09-01T00:00:00.000Z',
          costUsd: -1,
          observedAt: plan.observedAt,
          source: 'sidecar',
        },
      });
      const ledger = await readLedger(dir, 'work');
      expect(Object.keys(ledger?.windows ?? {})).toEqual(['seven_day']);
      expect(ledger?.plan).toEqual(plan);
      expect(ledger).not.toHaveProperty('spend');
    });

    it('reads a usedPct above 100 as 100 and below 0 as 0', async () => {
      await put({
        windows: { five_hour: { ...good, usedPct: 130 }, seven_day: { ...good, usedPct: -5 } },
      });
      const ledger = await readLedger(dir, 'work');
      expect(ledger?.windows.five_hour?.usedPct).toBe(100);
      expect(ledger?.windows.seven_day?.usedPct).toBe(0);
    });

    it('ignores unknown top-level keys on read and keeps them on write', async () => {
      await put({
        windows: { seven_day: good, five_hour: { ...good, source: 'a-future-source' } },
        writer: 'flow 9.9',
        aNewBlock: { x: 1 },
      });
      expect(Object.keys((await readLedger(dir, 'work'))?.windows ?? {})).toEqual(['seven_day']);
      await writeLedger(dir, 'work', [obs('seven_day_opus', 7)], NOW);
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'work.json'), 'utf8'));
      expect(onDisk).toMatchObject({ writer: 'flow 9.9', aNewBlock: { x: 1 } });
      // The entry this version cannot read stays on disk for the writer that can.
      expect(onDisk.windows.five_hour.source).toBe('a-future-source');
    });

    it('gives memory only what it can read after a write, and keeps the rest on disk', async () => {
      await put({
        windows: { seven_day: good },
        spend: {
          periodStart: '2026-09-01T00:00:00.000Z',
          costUsd: -1,
          observedAt: plan.observedAt,
          source: 'sidecar',
        },
      });
      const result = await writeLedger(dir, 'work', [obs('five_hour', 7)], NOW);
      expect(result.written).toBe(true);
      expect(result.ledger).not.toHaveProperty('spend');
      expect(Object.keys(result.ledger?.windows ?? {}).sort()).toEqual(['five_hour', 'seven_day']);
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'work.json'), 'utf8'));
      expect(onDisk.spend.costUsd).toBe(-1);
    });

    it('warns once about the same set-aside entry, however often the file is read', async () => {
      const warn = vi.spyOn(logger, 'warn');
      await put({ windows: { seven_day: good, five_hour: { ...good, source: 'once-only' } } });
      await readLedger(dir, 'work');
      await readLedger(dir, 'work');
      await readLedger(dir, 'work');
      const setAside = warn.mock.calls.filter(([message]) => String(message).includes('set aside'));
      expect(setAside).toHaveLength(1);
    });

    it('returns the tolerant read from a write that changes nothing', async () => {
      await put({
        windows: { five_hour: { ...good, source: 'a-future-source' }, seven_day: good },
      });
      const result = await writeLedger(dir, 'work', [obs('seven_day', 12, good.observedAt)], NOW);
      expect(result.written).toBe(false);
      expect(Object.keys(result.ledger?.windows ?? {})).toEqual(['seven_day']);
    });
  });

  it('deletes under the lock, and a missing file or folder is fine', async () => {
    expect(await deleteLedger(dir, 'work')).toBe(true);
    await writeLedger(dir, 'work', [obs('five_hour', 1)], NOW);
    expect(await deleteLedger(dir, 'work')).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('lists ledger files and ignores locks, temp, stale and corrupt names', async () => {
    await fs.mkdir(dir, { recursive: true });
    for (const name of [
      'a.json',
      'b.json',
      'b.json.lock',
      'b.json.1.ab.tmp',
      'b.json.lock.stale-ff',
      'b.json.corrupt-1',
      'Bad.json',
      'notes.txt',
    ]) {
      await fs.writeFile(path.join(dir, name), '{}');
    }
    expect((await listLedgerFiles(dir)).map((e) => e.id)).toEqual(['a', 'b']);
  });
});
