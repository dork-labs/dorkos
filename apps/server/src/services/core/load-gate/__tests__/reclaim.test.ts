/**
 * Taking a stale record away without taking anyone else's, and the lease
 * timed on a monotonic clock (DOR-4209). Real files in a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeaseWatch, takeAway } from '../reclaim.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-reclaim-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const slot = (): string => path.join(dir, 'slot-0.json');
/** What is left in the folder besides the slot: set-aside files must never linger. */
const leftovers = (): string[] => fs.readdirSync(dir).filter((name) => name !== 'slot-0.json');

describe('takeAway', () => {
  it('removes the record when the moved file is the one judged', () => {
    fs.writeFileSync(slot(), '{"id":"stale"}');
    expect(takeAway(dir, 'slot-0.json', () => true)).toBe(true);
    expect(fs.existsSync(slot())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('links the record back when the moved file is not the one judged', () => {
    fs.writeFileSync(slot(), '{"id":"fresh"}');
    expect(takeAway(dir, 'slot-0.json', () => false)).toBe(false);
    expect(fs.readFileSync(slot(), 'utf8')).toBe('{"id":"fresh"}');
    expect(leftovers()).toEqual([]);
  });

  it('keeps whoever took the name meanwhile, and leaves no set-aside file behind', () => {
    fs.writeFileSync(slot(), '{"id":"moved"}');
    const result = takeAway(dir, 'slot-0.json', () => {
      // Someone claims slot 0 while the moved record is being judged.
      fs.writeFileSync(slot(), '{"id":"newcomer"}');
      return false;
    });
    expect(result).toBe(false);
    expect(fs.readFileSync(slot(), 'utf8')).toBe('{"id":"newcomer"}');
    expect(leftovers()).toEqual([]);
  });

  it('does nothing for a record already gone', () => {
    expect(takeAway(dir, 'slot-0.json', () => true)).toBe(false);
  });
});

describe('LeaseWatch', () => {
  it('calls a file quiet only after watching one file time for a full monotonic lease', () => {
    let mono = 0;
    const watch = new LeaseWatch(30_000, () => mono);
    expect(watch.quiet('slot-0.json', 1_000)).toBe(false);
    mono = 29_999;
    expect(watch.quiet('slot-0.json', 1_000)).toBe(false);
    mono = 30_000;
    expect(watch.quiet('slot-0.json', 1_000)).toBe(true);
  });

  it('starts again on any change to the file time, forwards or back', () => {
    let mono = 0;
    const watch = new LeaseWatch(30_000, () => mono);
    watch.quiet('a', 1_000);
    mono = 40_000;
    // A wall-clock jump of an hour either way is just a change.
    expect(watch.quiet('a', 1_000 + 3_600_000)).toBe(false);
    mono = 60_000;
    expect(watch.quiet('a', 1_000 - 3_600_000)).toBe(false);
    mono = 89_999;
    expect(watch.quiet('a', 1_000 - 3_600_000)).toBe(false);
  });

  it('forgets files that are gone, so a new file under the name starts fresh', () => {
    let mono = 0;
    const watch = new LeaseWatch(30_000, () => mono);
    watch.quiet('a', 1_000);
    watch.retain(new Set());
    mono = 30_000;
    expect(watch.quiet('a', 1_000)).toBe(false);
  });
});
