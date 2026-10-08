/**
 * Waking, after a restart, a chat whose background work the restart stopped
 * (DOR-2065).
 *
 * The boot half: a record a previous run left behind wakes its chat exactly
 * once and is removed once the chat is settled, a record whose dispatch threw
 * survives for the next boot, and a room's or a task's chat is never woken.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchMessage = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({
  hasSession: vi.fn(() => true),
  getSession: vi.fn(async () => ({ id: 'x' })),
  getCapabilities: vi.fn(() => ({})),
}));

vi.mock('../../message-dispatcher.js', () => ({ dispatchMessage }));
vi.mock('../../session-state-projector.js', () => ({
  getOrCreateProjector: vi.fn(() => ({ cwd: undefined })),
}));
vi.mock('../../projector-persistence.js', () => ({ persistenceModeFor: vi.fn(() => 'none') }));
vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getNativeSessionCwd: vi.fn(() => null),
    resolveForSession: vi.fn(async () => runtime),
  },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ error: String(err) }),
}));

import {
  BackgroundWorkLedger,
  type BackgroundWorkRecord,
} from '../../../runtimes/claude-code/messaging/background-work-ledger.js';
import {
  CUT_SHORT_WAKE_MESSAGE,
  STALE_BACKGROUND_WORK_MS,
  wakeChatsCutShort,
} from '../wake-cut-short-work.js';

/** A record written moments ago, well inside the staleness bound. */
const RECENT = Date.now();

let dorkHome: string;
let ledger: BackgroundWorkLedger;

/** The boot path as `index.ts` wires it: read, wake, remove each settled record. */
async function boot(drivenElsewhere?: (ids: string[]) => ReadonlySet<string>): Promise<void> {
  await wakeChatsCutShort(ledger.read(), {
    release: (record: BackgroundWorkRecord) => ledger.release(record.key, record.since),
    ...(drivenElsewhere !== undefined ? { drivenElsewhere } : {}),
  });
}

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-work-wake-'));
  ledger = new BackgroundWorkLedger(dorkHome);
  dispatchMessage.mockReset();
  dispatchMessage.mockResolvedValue({ accepted: true });
  runtime.hasSession.mockReturnValue(true);
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('a boot with background work a previous run left behind', () => {
  it('wakes that chat exactly once and removes the record', async () => {
    ledger.hold({ key: 'k-1', sessionId: 'sess-1', cwd: '/projects/one', since: RECENT });

    await boot();

    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]![0]).toMatchObject({
      sessionId: 'sess-1',
      cwd: '/projects/one',
      content: CUT_SHORT_WAKE_MESSAGE,
      whenBusy: 'refuse',
    });
    expect(ledger.read()).toEqual([]);

    // The next boot finds nothing to wake.
    await boot();
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the record for the next boot when the dispatch throws', async () => {
    ledger.hold({ key: 'k-err', sessionId: 'sess-err', cwd: '/projects/err', since: RECENT });
    dispatchMessage.mockRejectedValueOnce(new Error('boom'));

    await expect(boot()).resolves.toBeUndefined();
    expect(ledger.read()).toEqual([expect.objectContaining({ key: 'k-err' })]);

    await boot();
    expect(dispatchMessage).toHaveBeenCalledTimes(2);
    expect(ledger.read()).toEqual([]);
  });

  it('removes the record of a busy chat without queueing a wake behind its turn', async () => {
    ledger.hold({ key: 'k-busy', sessionId: 'sess-busy', cwd: '/projects/busy', since: RECENT });
    dispatchMessage.mockResolvedValue({ accepted: false });

    await boot();

    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]![0].whenBusy).toBe('refuse');
    expect(ledger.read()).toEqual([]);
  });

  it('removes the record of a chat that no longer exists anywhere, waking nothing', async () => {
    ledger.hold({ key: 'k-gone', sessionId: 'sess-gone', cwd: '/projects/gone', since: RECENT });
    runtime.hasSession.mockReturnValue(false);
    runtime.getSession.mockResolvedValueOnce(null as never);

    await boot();

    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(ledger.read()).toEqual([]);
  });

  it('does not wake a room or scheduled-task chat, and removes its record', async () => {
    ledger.hold({ key: 'k-room', sessionId: 'sess-room', cwd: '/projects/room', since: RECENT });
    ledger.hold({ key: 'k-mine', sessionId: 'sess-mine', cwd: '/projects/mine', since: RECENT });

    await boot((ids) => new Set(ids.filter((id) => id === 'sess-room')));

    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]![0].sessionId).toBe('sess-mine');
    expect(ledger.read()).toEqual([]);
  });

  it('drops a record older than a day without waking its chat', async () => {
    const now = Date.now();
    ledger.hold({
      key: 'k-old',
      sessionId: 'sess-old',
      cwd: '/projects/old',
      since: now - STALE_BACKGROUND_WORK_MS - 1,
    });
    ledger.hold({ key: 'k-new', sessionId: 'sess-new', cwd: '/projects/new', since: now - 1 });

    await boot();

    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]![0].sessionId).toBe('sess-new');
    expect(ledger.read()).toEqual([]);
  });

  it('does not remove a record this run has written for the same chat since', async () => {
    ledger.hold({ key: 'k-1', sessionId: 'sess-1', cwd: '/projects/one', since: RECENT });
    const records = ledger.read();
    // The chat's process starts holding work again before its wake settles.
    ledger.hold({ key: 'k-1', sessionId: 'sess-1', cwd: '/projects/one', since: RECENT + 1 });

    await wakeChatsCutShort(records, {
      release: (record) => ledger.release(record.key, record.since),
    });

    expect(ledger.read()).toEqual([expect.objectContaining({ since: RECENT + 1 })]);
  });
});
