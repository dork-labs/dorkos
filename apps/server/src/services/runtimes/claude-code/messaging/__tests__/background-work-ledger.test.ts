/**
 * The durable record of chats holding background work (DOR-2065).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundWorkLedger } from '../background-work-ledger.js';

let dorkHome: string;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-work-ledger-'));
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('BackgroundWorkLedger', () => {
  it('lives beside the warm-process ledger under the data directory', () => {
    const ledger = new BackgroundWorkLedger(dorkHome);
    expect(ledger.path).toBe(
      path.join(dorkHome, 'cache', 'runtimes', 'claude-code', 'background-work.json')
    );
  });

  it('holds one record per key and releases it', () => {
    const ledger = new BackgroundWorkLedger(dorkHome);
    ledger.hold({ key: 'a', sessionId: 'a', cwd: '/p', since: 1 });
    ledger.hold({ key: 'a', sessionId: 'a', cwd: '/q', since: 2 });
    ledger.hold({ key: 'b', sessionId: 'b-sdk', cwd: '/p', since: 3 });
    expect(ledger.read()).toEqual([
      { key: 'a', sessionId: 'a', cwd: '/q', since: 2 },
      { key: 'b', sessionId: 'b-sdk', cwd: '/p', since: 3 },
    ]);

    expect(ledger.release('a')).toMatchObject({ key: 'a' });
    expect(ledger.release('a')).toBeUndefined();
    expect(ledger.read()).toEqual([{ key: 'b', sessionId: 'b-sdk', cwd: '/p', since: 3 }]);

    ledger.release('b');
    expect(fs.existsSync(ledger.path)).toBe(false);
  });

  it('reads an unreadable file as empty', () => {
    const ledger = new BackgroundWorkLedger(dorkHome);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(ledger.path, '{"sessions": [');
    expect(ledger.read()).toEqual([]);
  });

  it('releases a record only when it is the one asked about', () => {
    const ledger = new BackgroundWorkLedger(dorkHome);
    ledger.hold({ key: 'a', sessionId: 'a', cwd: '/p', since: 2 });
    // A boot settling the previous run's record (since 1) must not remove the
    // record this run has written for the same chat since.
    expect(ledger.release('a', 1)).toBeUndefined();
    expect(ledger.read()).toHaveLength(1);
    expect(ledger.release('a', 2)).toMatchObject({ since: 2 });
    expect(ledger.read()).toEqual([]);
  });
});

describe('BackgroundWorkLedger bound to its data directory (DOR-3071)', () => {
  const record = { key: 'a', sessionId: 'live-chat', cwd: '/p', since: 1 };
  let elsewhere: string;

  beforeEach(() => {
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-work-copy-'));
  });

  afterEach(() => {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('wakes on a restart of the same data directory', () => {
    new BackgroundWorkLedger(dorkHome).hold(record);
    expect(new BackgroundWorkLedger(dorkHome).readLeftover()).toEqual([record]);
  });

  it('matches the same data directory reached through a symlink', () => {
    new BackgroundWorkLedger(dorkHome).hold(record);
    const link = path.join(elsewhere, 'link');
    fs.symlinkSync(dorkHome, link);
    expect(new BackgroundWorkLedger(link).readLeftover()).toEqual([record]);
  });

  it('wakes nothing from a copied data directory, says so, and drops the file', () => {
    new BackgroundWorkLedger(dorkHome).hold(record);
    fs.cpSync(dorkHome, elsewhere, { recursive: true });

    const copy = new BackgroundWorkLedger(elsewhere);
    expect(fs.existsSync(copy.path)).toBe(true);
    expect(copy.readLeftover()).toEqual([]);
    expect(fs.existsSync(copy.path)).toBe(false);
    // The original is untouched and still wakes its own chat.
    expect(new BackgroundWorkLedger(dorkHome).readLeftover()).toEqual([record]);
  });

  it('wakes nothing after the data directory is moved', () => {
    new BackgroundWorkLedger(dorkHome).hold(record);
    const moved = path.join(elsewhere, 'moved');
    fs.renameSync(dorkHome, moved);
    expect(new BackgroundWorkLedger(moved).readLeftover()).toEqual([]);
  });

  it('does not carry a copied record into the copy’s own writes', () => {
    new BackgroundWorkLedger(dorkHome).hold(record);
    fs.cpSync(dorkHome, elsewhere, { recursive: true });

    const copy = new BackgroundWorkLedger(elsewhere);
    expect(copy.read()).toEqual([]);
    const own = { key: 'b', sessionId: 'copy-chat', cwd: '/q', since: 2 };
    copy.hold(own);
    expect(new BackgroundWorkLedger(elsewhere).readLeftover()).toEqual([own]);
  });

  it('still wakes a file written before the binding, so an upgrade keeps its work', () => {
    const ledger = new BackgroundWorkLedger(dorkHome);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(ledger.path, JSON.stringify({ sessions: [record] }));
    expect(ledger.readLeftover()).toEqual([record]);
  });
});
