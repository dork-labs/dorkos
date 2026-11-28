/**
 * Waking, after a restart, a chat whose background work the restart stopped
 * (DOR-2065): one chat's wake, as the `lost_work_wake` handler calls it. Which
 * records wake, once each, and which are let go is recovery's, proven in
 * `services/runs/__tests__/restart-matrix-lost-work.test.ts` (K13).
 *
 * @vitest-environment node
 */
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
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    resolveForSession: vi.fn(async () => runtime),
  },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ error: String(err) }),
}));

import { CUT_SHORT_WAKE_MESSAGE, wakeCutShortChat } from '../wake-cut-short-work.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { noteTurnHold, setContinuationHoldDb } from '../../../core/turn-power/continuation-hold.js';

beforeEach(() => {
  dispatchMessage.mockReset();
  dispatchMessage.mockResolvedValue({ accepted: true });
  runtime.hasSession.mockReturnValue(true);
});

afterEach(() => setContinuationHoldDb(undefined));

describe('a wake for a chat whose latest turn was held (DOR-3037)', () => {
  it('runs at the runtime default, and a chat whose turn was not held runs as it was', async () => {
    setContinuationHoldDb(createTestDb());
    noteTurnHold('sess-held', true);
    noteTurnHold('sess-free', false);
    await wakeCutShortChat({ sessionId: 'sess-held', cwd: '/projects/one' });
    await wakeCutShortChat({ sessionId: 'sess-free', cwd: '/projects/two' });
    const bySession = new Map(
      dispatchMessage.mock.calls.map((call) => [call[0].sessionId, call[0].permissionCeiling])
    );
    expect(bySession.get('sess-held')).toBe('runtime-default');
    expect(bySession.get('sess-free')).toBeUndefined();
  });

  it('after a restart, holds a held chat and runs a chat with no record at its own level (DOR-3203)', async () => {
    const db = createTestDb();
    setContinuationHoldDb(db);
    noteTurnHold('sess-held', true);
    // A new process: the same rows, nothing in memory. `sess-old` ran before the
    // hold was recorded, so it has no row at all.
    setContinuationHoldDb(db);
    await wakeCutShortChat({ sessionId: 'sess-held', cwd: '/projects/one' });
    await wakeCutShortChat({ sessionId: 'sess-old', cwd: '/projects/two' });
    const bySession = new Map(
      dispatchMessage.mock.calls.map((call) => [call[0].sessionId, call[0]])
    );
    expect(bySession.get('sess-held')).toMatchObject({
      permissionCeiling: 'runtime-default',
      continuationHold: true,
    });
    expect(bySession.get('sess-old')?.permissionCeiling).toBeUndefined();
    expect(bySession.get('sess-old')?.continuationHold).toBeUndefined();
  });
});

describe('one chat’s wake', () => {
  it('starts a turn with today’s message under the key its run is made under', async () => {
    const outcome = await wakeCutShortChat({
      sessionId: 'sess-1',
      cwd: '/projects/one',
      startKey: 'lost-work:sess-1:1',
    });

    expect(outcome).toBe('woken');
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]![0]).toMatchObject({
      turnStarter: 'agent',
      origin: { kind: 'resume' },
      sessionId: 'sess-1',
      cwd: '/projects/one',
      content: CUT_SHORT_WAKE_MESSAGE,
      whenBusy: 'refuse',
      startKey: 'lost-work:sess-1:1',
    });
  });

  it('answers failed when the dispatch throws, so it is tried again', async () => {
    dispatchMessage.mockRejectedValueOnce(new Error('boom'));
    await expect(wakeCutShortChat({ sessionId: 's', cwd: '/p' })).resolves.toBe('failed');
  });

  it('answers busy, queueing nothing behind a running turn', async () => {
    dispatchMessage.mockResolvedValue({ accepted: false });
    await expect(wakeCutShortChat({ sessionId: 's', cwd: '/p' })).resolves.toBe('busy');
    expect(dispatchMessage.mock.calls[0]![0].whenBusy).toBe('refuse');
  });

  it('answers gone for a chat that no longer exists anywhere, waking nothing', async () => {
    runtime.hasSession.mockReturnValue(false);
    runtime.getSession.mockResolvedValueOnce(null as never);
    await expect(wakeCutShortChat({ sessionId: 's', cwd: '/p' })).resolves.toBe('gone');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});
