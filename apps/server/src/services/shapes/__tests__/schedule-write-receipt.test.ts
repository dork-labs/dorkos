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
import { ShapeScheduleReceipts, SCHEDULE_RECEIPT_FILENAME } from '../schedule-write-receipt.js';

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
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
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
});
