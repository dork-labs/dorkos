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
    expect(ledger.takeAll()).toEqual([]);
  });
});
