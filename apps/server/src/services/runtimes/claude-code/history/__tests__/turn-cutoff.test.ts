/**
 * DOR-3307: a stall-guard cutoff never reads as a person's stop.
 *
 * Drives the real guard over a turn with a tool in flight, then reads what each
 * side sees afterwards: the chat (the guard's own error, and the reopened
 * transcript the CLI wrote, through the real parser and the overlay) and the
 * agent (the note its next turn carries). A person's Stop, with no recorded
 * cutoff, still reads as a person's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HistoryMessage, StreamEvent } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import { withStallGuard } from '../../../../session/stall-guard.js';
import { resetTurnCutoffs, takeTurnCutoff } from '../../../../session/turn-cutoff/turn-cutoff.js';
import type { RecordedTurnCutoff } from '../../../../session/session-event-store.js';
import { parseTranscript } from '../../sessions/transcript-parser.js';
import { renderContextEntry } from '../../messaging/context-builder.js';
import { applyTurnCutoffs } from '../turn-cutoff-overlay.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));

const SESSION_ID = 'dor-3307-session';
const TIMEOUT_MS = 10 * 60 * 1000;

/** The words a person's stop is written in, which a cutoff must never show. */
const PERSON_WORDING = /user doesn't want|interrupted by user|wait for the user/i;

/** What the CLI writes when a turn is interrupted while `Bash` is running. */
const CUT_TRANSCRIPT = [
  {
    type: 'user',
    uuid: 'u-ask',
    timestamp: '2026-10-26T00:30:00.000Z',
    message: { role: 'user', content: 'Run the browser check.' },
  },
  {
    type: 'assistant',
    uuid: 'a-tool',
    timestamp: '2026-10-26T00:30:52.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-cut', name: 'Bash', input: { command: 'sleep 900' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u-result',
    timestamp: '2026-10-26T00:41:50.568Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-cut',
          is_error: true,
          content:
            "The user doesn't want to proceed with this tool use. The tool use was rejected. " +
            'STOP what you are doing and wait for the user to tell you how to proceed.',
        },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u-marker',
    timestamp: '2026-10-26T00:41:50.570Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
    },
  },
].map((line) => JSON.stringify(line));

/** A source that starts a tool and then goes quiet forever. */
async function* toolThenSilence(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'tool_call_start',
    data: { toolCallId: 'tool-cut', toolName: 'Bash', input: '{"command":"sleep 900"}' },
  } as StreamEvent;
  await new Promise<never>(() => {});
}

/** Run the guard to its cutoff, with fake time standing in for ten quiet minutes. */
async function cutTurn(): Promise<StreamEvent[]> {
  vi.useFakeTimers();
  try {
    const events: StreamEvent[] = [];
    const run = (async () => {
      for await (const event of withStallGuard(toolThenSilence(), {
        sessionId: SESSION_ID,
        timeoutMs: TIMEOUT_MS,
        isPaused: () => false,
        onStall: async () => mockInterruptReceipt('acked'),
      })) {
        events.push(event);
      }
    })();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1_000);
    await run;
    return events;
  } finally {
    vi.useRealTimers();
  }
}

/** The cutoff as the event store hands it back, from the guard's own error. */
function recorded(error: StreamEvent, createdAt: string): RecordedTurnCutoff {
  return { event: { seq: 7, ...(error.data as object) }, createdAt } as RecordedTurnCutoff;
}

/** Every string a person could read in a history, joined. */
function shown(messages: HistoryMessage[]): string {
  return JSON.stringify(messages);
}

describe('a stall-guard cutoff on a turn with a tool in flight (DOR-3307)', () => {
  beforeEach(() => resetTurnCutoffs());

  it('tells the chat that DorkOS stopped the turn after N minutes', async () => {
    const events = await cutTurn();
    const error = events.find((event) => event.type === 'error');

    expect(error?.data).toMatchObject({
      code: 'turn_stalled',
      message: 'DorkOS stopped this turn after 10 minutes with no activity.',
    });
    expect(JSON.stringify(error)).not.toMatch(PERSON_WORDING);
  });

  it('tells the agent on its next turn that no person stopped it', async () => {
    await cutTurn();
    const cutoff = takeTurnCutoff(SESSION_ID);

    expect(cutoff).toEqual({ windowMs: TIMEOUT_MS, neverStarted: false });
    const note = renderContextEntry({ kind: 'turn_cutoff', scope: 'per-turn', data: cutoff! });
    expect(note).toContain('<turn_cutoff>');
    expect(note).toContain('DorkOS stopped your last turn after 10 minutes with no activity.');
    expect(note).toContain('No person stopped it, and nobody declined anything.');
    // Taken, not peeked: the note rides exactly one turn.
    expect(takeTurnCutoff(SESSION_ID)).toBeNull();
  });

  it('shows the reopened transcript with the cutoff wording, never "user"', async () => {
    const events = await cutTurn();
    const error = events.find((event) => event.type === 'error')!;
    const parsed = parseTranscript(CUT_TRANSCRIPT);
    // Before the overlay, the CLI's own lines speak for a person.
    expect(shown(parsed)).toMatch(PERSON_WORDING);

    const history = applyTurnCutoffs(parsed, [recorded(error, '2026-10-26T00:41:50.600Z')]);

    expect(shown(history)).not.toMatch(PERSON_WORDING);
    const tool = history.flatMap((m) => m.toolCalls ?? []).find((c) => c.toolCallId === 'tool-cut');
    expect(tool).toMatchObject({
      status: 'error',
      result: 'DorkOS stopped this turn after 10 minutes with no activity.',
    });
    expect(tool?.approvalOutcome).toBeUndefined();
    const part = history
      .flatMap((m) => m.parts ?? [])
      .find((p) => p.type === 'tool_call' && p.toolCallId === 'tool-cut');
    expect(part).not.toHaveProperty('approvalOutcome');
    expect(part).not.toHaveProperty('interactiveType');
    expect(history.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'error', code: 'turn_stalled', message: expect.stringContaining('DorkOS') }],
    });
    // The parser's own output is left as it was.
    expect(shown(parsed)).toMatch(PERSON_WORDING);
  });

  it("still shows a person's Stop as a person's", () => {
    const parsed = parseTranscript(CUT_TRANSCRIPT);

    expect(applyTurnCutoffs(parsed, [])).toBe(parsed);
    // A cutoff from another turn, before this one, claims none of its lines.
    const earlier = recorded(
      { type: 'error', data: { message: 'DorkOS stopped this turn.', code: 'turn_stalled' } },
      '2026-10-26T00:10:00.000Z'
    );
    const history = applyTurnCutoffs(parsed, [earlier]);
    expect(history.find((m) => m.id === 'u-marker')?.content).toBe(
      '[Request interrupted by user for tool use]'
    );
  });

  it('puts a cutoff the CLI wrote no line for into the chat by time', () => {
    const parsed = parseTranscript(CUT_TRANSCRIPT.slice(0, 2));
    const cutoff = recorded(
      { type: 'error', data: { message: 'DorkOS stopped this turn.', code: 'turn_stalled' } },
      '2026-10-26T00:41:51.000Z'
    );

    const history = applyTurnCutoffs(parsed, [cutoff]);

    expect(history).toHaveLength(parsed.length + 1);
    expect(history.at(-1)).toMatchObject({ id: 'turn-cutoff-7', role: 'assistant' });
  });
});
