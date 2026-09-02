/**
 * Tests for {@link ShapeScheduleReceipts} against a real temp directory.
 *
 * The service tests cover what the receipt MEANS (who may overwrite what, who
 * may delete what). These cover the file itself: that it survives a restart,
 * that it never loses a concurrent write, and that a receipt it cannot read
 * fails in the safe direction.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import {
  ShapeScheduleReceipts,
  SCHEDULE_ADOPTION_FILENAME,
  SCHEDULE_RECEIPT_FILENAME,
  resetShapeScheduleReceipts,
  shapeScheduleReceipts,
} from '../schedule-write-receipt.js';

/** Whether a path is there at all. */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('ShapeScheduleReceipts', () => {
  let dorkHome: string;
  let logger: Logger;

  /** A fresh instance over the same directory — a restart, in effect. */
  function receipts(): ShapeScheduleReceipts {
    return new ShapeScheduleReceipts({ dorkHome, logger });
  }

  beforeEach(async () => {
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-receipt-'));
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
  });

  afterEach(async () => {
    resetShapeScheduleReceipts();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('remembers a write across a restart, and forgets on request', async () => {
    const dir = path.join(dorkHome, 'skills', 'inbox-tick');
    await fs.mkdir(dir, { recursive: true });

    await receipts().record(dir, 'linear-ops');
    expect(await receipts().ownerOf(dir)).toBe('linear-ops');

    await receipts().forget(dir);
    expect(await receipts().ownerOf(dir)).toBeNull();
  });

  it('matches a directory reached by a different spelling of the same path', async () => {
    // A data directory under a symlinked parent is ordinary rather than exotic
    // — every macOS temp directory is one — and the row a lookup starts from
    // may carry either spelling. Both have to find the same entry, or a Shape
    // stops recognising the schedule it wrote a moment ago.
    const real = path.join(dorkHome, 'real-root', 'inbox-tick');
    await fs.mkdir(real, { recursive: true });
    await fs.symlink(path.join(dorkHome, 'real-root'), path.join(dorkHome, 'linked-root'));

    await receipts().record(real, 'linear-ops');

    expect(await receipts().ownerOf(path.join(dorkHome, 'linked-root', 'inbox-tick'))).toBe(
      'linear-ops'
    );
  });

  it('loses nothing when several writes land at once', async () => {
    // One shared file, read-modify-written per entry: interleaved snapshots
    // would drop whichever entry lost the race, and a dropped entry is a
    // schedule its own Shape can no longer tear down.
    const store = receipts();
    const dirs = ['a', 'b', 'c', 'd'].map((n) => path.join(dorkHome, 'skills', n));
    await Promise.all(dirs.map((d) => store.record(d, 'linear-ops')));

    const reread = receipts();
    for (const dir of dirs) expect(await reread.ownerOf(dir)).toBe('linear-ops');
  });

  it('treats a receipt it cannot read as present but empty, and says so', async () => {
    // Fail-closed, in both directions. Nothing is owned, so no directory is
    // overwritten or deleted on a guess — and the file still counts as PRESENT,
    // so the one-time marker adoption does not run again and re-grant the
    // ownership the receipt exists to take away.
    await fs.writeFile(path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME), '{ not json', 'utf-8');
    const store = receipts();
    const discover = vi.fn(async () => [{ dir: '/somewhere', shape: 'linear-ops' }]);

    await store.adoptOnce(discover);

    expect(discover).not.toHaveBeenCalled();
    expect(await store.ownerOf('/somewhere')).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
  });

  it('adopts once, and writes the receipt even when it adopted nothing', async () => {
    // The file's EXISTENCE is what records that adoption already happened, so a
    // fresh install has to write one too — otherwise every later operation would
    // re-scan, and a marker forged next week would be adopted.
    const store = receipts();
    const discover = vi.fn(async () => []);

    await store.adoptOnce(discover);
    await store.adoptOnce(discover);

    expect(discover).toHaveBeenCalledTimes(1);
    expect(await receipts().ownerOf('/anything')).toBeNull();
    await expect(
      fs.readFile(path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME), 'utf-8')
    ).resolves.toContain('"entries"');
  });
  it('does not adopt again after the receipt file is deleted', async () => {
    // THE ONE A REVIEWER REPRODUCED. Keying "adoption already ran" on the
    // receipt's own existence meant `rm shape-schedule-receipts.json` re-ran a
    // migration that reads ownership out of frontmatter — handing a Shape every
    // marked file on the machine again, the person's adapted copy included.
    const first = receipts();
    await first.adoptOnce(async () => []);
    expect(await exists(path.join(dorkHome, SCHEDULE_ADOPTION_FILENAME))).toBe(true);

    await fs.rm(path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME));

    const afterDeletion = receipts(); // a restart
    const discover = vi.fn(async () => [{ dir: '/copied', shape: 'linear-ops' }]);
    await afterDeletion.adoptOnce(discover);

    expect(discover).not.toHaveBeenCalled();
    expect(await afterDeletion.ownerOf('/copied')).toBeNull();
  });

  it('counts a receipt written before the marker file existed as already adopted', async () => {
    // An install that upgraded mid-development of this change has a receipt and
    // no marker file. It has ownership facts to lose, so it must not be adopted
    // over — and it gets the marker written so the question is settled.
    await fs.writeFile(
      path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME),
      JSON.stringify({ version: 1, entries: [] }),
      'utf-8'
    );
    const discover = vi.fn(async () => [{ dir: '/copied', shape: 'linear-ops' }]);

    await receipts().adoptOnce(discover);

    expect(discover).not.toHaveBeenCalled();
    expect(await exists(path.join(dorkHome, SCHEDULE_ADOPTION_FILENAME))).toBe(true);
  });

  it('keeps an unreadable receipt beside the new one instead of discarding it', async () => {
    // Those bytes are the only record of which directory belonged to which
    // Shape, and nothing on disk can reconstruct them. Replacing them with a
    // single fresh entry would silently drop every other one.
    const receiptPath = path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME);
    await fs.writeFile(receiptPath, '{ not json', 'utf-8');
    const store = receipts();
    await store.ownerOf('/anything'); // forces the failed read

    await store.record(path.join(dorkHome, 'skills', 'fresh'), 'linear-ops');

    const kept = (await fs.readdir(dorkHome)).filter((n) => n.includes('.unreadable-'));
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(dorkHome, kept[0]), 'utf-8')).toBe('{ not json');
  });

  it('hands every caller in one data directory the same receipt', async () => {
    // Two instances over one file means two caches and two write chains: a
    // directory dropped through one is still owned according to the other,
    // which is the stale claim the receipt exists to prevent.
    expect(shapeScheduleReceipts(dorkHome, logger)).toBe(shapeScheduleReceipts(dorkHome, logger));
  });

  it('tells the caller when a forget could not be written', async () => {
    // `record` swallows a write failure (the schedule file already exists, and
    // an unrecorded directory is merely unowned). `forget` must not: it leaves a
    // claim on a directory being handed back to the person.
    const dir = path.join(dorkHome, 'skills', 'inbox-tick');
    await fs.mkdir(dir, { recursive: true });
    const store = receipts();
    await store.record(dir, 'linear-ops');
    // A directory where the file has to go is the simplest unwritable receipt.
    await fs.rm(path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME));
    await fs.mkdir(path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME));

    await expect(store.forget(dir)).rejects.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not write the schedule receipt'),
      expect.anything()
    );
  });
});
