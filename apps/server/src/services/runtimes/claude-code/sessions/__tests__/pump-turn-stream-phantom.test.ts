/**
 * The DOR-1087 tripwire on the PERSISTENT path (spec `persistent-session-runtime`
 * task 5.2, DOR-1288).
 *
 * Persistence is hypothesised to remove phantom cancellations entirely, and that
 * hypothesis is deliberately unverified — task 5.1 is the measurement. So the
 * thing that must be true here is narrow and load-bearing: a phantom arriving on
 * the pump path is COUNTED and WARNED, so a zero in the measurement means "none
 * happened" rather than "nobody was looking".
 *
 * A tripwire that cries wolf is not a tripwire either, so the two ways a sentinel
 * is legitimate are tested alongside: a real operator stop inside the suppression
 * window, and a real UI deny (which carries its own wording, never the CLI's
 * sentinel).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../../lib/logger.js';
import {
  phantomCancellationStats,
  resetPhantomCancellations,
} from '../../../../observability/phantom-cancellations.js';
import { CLI_INTERRUPT_SENTINEL } from '../../messaging/phantom-cancellation.js';
import type { MessageSenderOpts } from '../../messaging/message-sender-shared.js';
import type { AgentSession } from '../../agent-types.js';
import { streamTurnWindow } from '../pump-turn-stream.js';
import type { TurnWindow } from '../session-turn-windows.js';

// Inert mapper: the phantom path reads the RAW SDK message and yields its own
// system_status, independent of anything the mapper produces.
vi.mock('../../sdk/sdk-event-mapper.js', () => ({
  mapSdkMessage: vi.fn(async function* () {}),
}));

const SESSION_ID = 'sess-pump-1';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeOpts(): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {} };
}

/**
 * A `tool_result` batch, as the CLI writes one. `content` defaults to the CLI's
 * own interrupt sentinel — the phantom shape; pass a deny string for the real
 * refusal the UI writes.
 */
function toolResultMsg(
  toolUseIds: string[],
  opts: { parentToolUseId?: string | null; content?: string } = {}
): SDKMessage {
  return {
    type: 'user',
    uuid: `u-${toolUseIds[0]}`,
    session_id: 'sdk-1',
    parent_tool_use_id: opts.parentToolUseId ?? null,
    message: {
      role: 'user',
      content: toolUseIds.map((tool_use_id) => ({
        type: 'tool_result',
        tool_use_id,
        is_error: true,
        content: opts.content ?? CLI_INTERRUPT_SENTINEL,
      })),
    },
  } as unknown as SDKMessage;
}

function makeWindow(messages: SDKMessage[]): TurnWindow {
  return {
    ids: ['msg-1'],
    origin: 'user',
    messages: {
      [Symbol.asyncIterator]: async function* () {
        for (const message of messages) yield message;
      },
    },
  };
}

async function runWindow(
  session: AgentSession,
  messages: SDKMessage[]
): Promise<{ events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  for await (const event of streamTurnWindow({
    sessionId: SESSION_ID,
    session,
    window: makeWindow(messages),
    opts: makeOpts(),
    meshAgentId: undefined,
  })) {
    events.push(event);
  }
  return { events };
}

/** The operator-facing notice, recognized by its text (it carries no `status`). */
function isPhantomStatus(e: StreamEvent): boolean {
  const data = e.data as { message?: string; status?: string };
  return (
    e.type === 'system_status' &&
    data.status === undefined &&
    typeof data.message === 'string' &&
    data.message.includes('background task finished at the wrong moment')
  );
}

function phantomWarnings(): Array<[string, Record<string, unknown>]> {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter((call) => String(call[0]).startsWith('[phantom-cancellation]')) as Array<
    [string, Record<string, unknown>]
  >;
}

beforeEach(() => {
  resetPhantomCancellations();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPhantomCancellations();
});

describe('streamTurnWindow — the phantom tripwire on the persistent path', () => {
  it('counts a synthetic phantom against the pump path and warns', async () => {
    const { events } = await runWindow(makeSession(), [toolResultMsg(['toolu_phantom'])]);

    const stats = phantomCancellationStats();
    expect(stats.byPath).toEqual({ turn: 0, pump: 1 });
    expect(stats.total).toBe(1);
    expect(stats.recent[0]).toMatchObject({
      sessionId: SESSION_ID,
      path: 'pump',
      toolUseIds: ['toolu_phantom'],
      mainThread: true,
      // The pump never steers a correction back into the model — that is a
      // decision, not a gap (see the module doc). If this ever reads `true`, the
      // measurement's "no correction is masking the symptom" premise is gone.
      steered: false,
    });

    expect(phantomWarnings()).toHaveLength(1);
    expect(phantomWarnings()[0][1]).toMatchObject({ session: SESSION_ID, path: 'pump' });
    // The operator still sees it, exactly as on the resume path.
    expect(events.filter(isPhantomStatus)).toHaveLength(1);
  });

  it('counts every call the CLI cancelled in one batch', async () => {
    await runWindow(makeSession(), [toolResultMsg(['toolu_a', 'toolu_b', 'toolu_c'])]);

    const stats = phantomCancellationStats();
    expect(stats.total).toBe(3);
    expect(stats.batches).toBe(1);
  });

  it('records a subagent phantom against the Task that dispatched it', async () => {
    await runWindow(makeSession(), [
      toolResultMsg(['toolu_inside_helper'], { parentToolUseId: 'toolu_task_1' }),
    ]);

    expect(phantomCancellationStats()).toMatchObject({ subagent: 1, mainThread: 0 });
    expect(phantomCancellationStats().recent[0].parentToolUseId).toBe('toolu_task_1');
  });

  it('does NOT fire for a real operator stop inside the suppression window', async () => {
    // `interruptQuery`/`stopTask` stamp this; the sentinels that follow are the
    // stop's own fallout, and counting them would report the operator's Escape
    // as a runtime bug.
    const session = makeSession({ interruptRequestedAt: Date.now() });

    const { events } = await runWindow(session, [toolResultMsg(['toolu_stopped_by_operator'])]);

    expect(phantomCancellationStats().total).toBe(0);
    expect(phantomWarnings()).toHaveLength(0);
    expect(events.filter(isPhantomStatus)).toHaveLength(0);
  });

  it('does NOT fire for a real UI deny, which carries its own wording', async () => {
    const { events } = await runWindow(makeSession(), [
      toolResultMsg(['toolu_denied'], {
        content: 'User denied tool execution. Reason: not right now',
      }),
    ]);

    expect(phantomCancellationStats().total).toBe(0);
    expect(phantomWarnings()).toHaveLength(0);
    expect(events.filter(isPhantomStatus)).toHaveLength(0);
  });
});
