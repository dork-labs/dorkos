/**
 * Waking a chat whose agent process was ended while its background work still
 * ran (DOR-2065).
 *
 * The boot half: a record a previous run left behind wakes its chat exactly
 * once, and the record is gone afterwards, so a second boot wakes nothing.
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
  runtimeRegistry: { resolveForSession: vi.fn(async () => runtime) },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ error: String(err) }),
}));

import { BackgroundWorkLedger } from '../../../runtimes/claude-code/messaging/background-work-ledger.js';
import { CUT_SHORT_WAKE_MESSAGE, wakeChatsCutShort } from '../wake-cut-short-work.js';

let dorkHome: string;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-work-wake-'));
  dispatchMessage.mockReset();
  dispatchMessage.mockResolvedValue({ accepted: true });
  runtime.hasSession.mockReturnValue(true);
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('a boot with background work a previous run left behind', () => {
  it('wakes that chat exactly once and clears the record', async () => {
    const ledger = new BackgroundWorkLedger(dorkHome);
    ledger.hold({ key: 'k-1', sessionId: 'sess-1', cwd: '/projects/one', since: 1 });

    await wakeChatsCutShort(ledger.takeAll());

    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]![0]).toMatchObject({
      sessionId: 'sess-1',
      cwd: '/projects/one',
      content: CUT_SHORT_WAKE_MESSAGE,
      whenBusy: 'refuse',
    });
    expect(ledger.read()).toEqual([]);
    expect(fs.existsSync(ledger.path)).toBe(false);

    // The next boot finds nothing to wake.
    await wakeChatsCutShort(ledger.takeAll());
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('does not queue a wake behind a turn that is already running', async () => {
    dispatchMessage.mockResolvedValue({ accepted: false });
    await wakeChatsCutShort([{ sessionId: 'sess-busy', cwd: '/projects/busy' }]);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]![0].whenBusy).toBe('refuse');
  });

  it('wakes nothing for a chat that no longer exists anywhere', async () => {
    runtime.hasSession.mockReturnValue(false);
    runtime.getSession.mockResolvedValueOnce(null as never);
    await wakeChatsCutShort([{ sessionId: 'sess-gone', cwd: '/projects/gone' }]);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('never rejects when a dispatch throws', async () => {
    dispatchMessage.mockRejectedValue(new Error('boom'));
    await expect(
      wakeChatsCutShort([{ sessionId: 'sess-err', cwd: '/projects/err' }])
    ).resolves.toBeUndefined();
  });
});
