/**
 * A turn that is still talking is active, however long ago it started
 * (DOR-2705).
 *
 * Record eviction spares a running turn only while `lastActivity` is under the
 * four-hour ceiling, and `lastActivity` used to be stamped only when a turn
 * STARTED. So every turn still working four hours in was evicted by the next
 * health sweep, its process torn down mid-work, and the person read "DorkOS
 * closed the agent before it finished this turn". Every such kill in the logs
 * landed at 240 to 244 minutes. Each frame the turn produces now stamps it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../lib/logger.js';
import { SESSIONS } from '../../../../../config/constants.js';
import { SessionLockManager } from '../../../../session/session-lock.js';
import { SessionStore } from '../session-store.js';
import { streamTurnWindow } from '../pump-turn-stream.js';
import type { TurnWindow } from '../session-turn-windows.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));

const SESSION_ID = 'sess-long-turn';
const FOUR_HOURS = SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS;

function assistant(text: string): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: `a-${text}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('streamTurnWindow keeps a long, working turn active (DOR-2705)', () => {
  it('survives the health sweep four hours and five minutes in, while still talking', async () => {
    const store = new SessionStore();
    store.ensureSession(SESSION_ID, { permissionMode: 'default' });
    const session = store.findSession(SESSION_ID)!;
    session.activeQuery = {} as Query;
    const startedAt = Date.now();

    // The turn talks for four hours and five minutes, one frame every five
    // minutes, and is still open when the sweep runs.
    const window: TurnWindow = {
      ids: ['msg-1'],
      origin: 'user',
      messages: {
        [Symbol.asyncIterator]: async function* () {
          for (let minute = 5; minute <= 245; minute += 5) {
            vi.setSystemTime(startedAt + minute * 60_000);
            yield assistant(`step-${minute}`);
          }
        },
      },
    };
    const stream = streamTurnWindow({
      sessionId: SESSION_ID,
      session,
      window,
      opts: { cwd: '/mock/project', onSdkSessionRebind: async () => {} },
      meshAgentId: undefined,
    });
    for await (const _event of stream) {
      // Drain: the frames are what this test is about, not the events.
    }

    expect(Date.now() - startedAt).toBeGreaterThan(FOUR_HOURS);
    expect(session.lastActivity).toBe(startedAt + 245 * 60_000);
    expect(store.checkSessionHealth(new SessionLockManager(), () => false)).toEqual([]);
    expect(store.findSession(SESSION_ID)).toBeDefined();
  });
});
