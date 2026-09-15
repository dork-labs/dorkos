import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';

import {
  UNREADABLE_MESSAGE_TEXT,
  UNREADABLE_PROMPT_TEXT,
  createUnreadableSnapshotReporter,
  parseSessionEvent,
  parseSessionSnapshot,
} from '../tolerant-session-frames';

const STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
  lastError: null,
};

const GOOD_BEFORE = {
  id: 'm1',
  role: 'user' as const,
  content: 'Hello',
};
const GOOD_AFTER = {
  id: 'm3',
  role: 'assistant' as const,
  content: 'Done',
  parts: [{ type: 'text' as const, text: 'Done' }],
};

function snapshotWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    messages: [],
    inProgressTurn: null,
    status: STATUS,
    pendingInteractions: [],
    queuedMessages: [],
    canvas: [],
    cursor: 5,
    ...overrides,
  };
}

describe('parseSessionSnapshot', () => {
  it('returns a fully valid snapshot unchanged, with nothing unreadable', () => {
    const valid: SessionSnapshot = snapshotWith({
      messages: [GOOD_BEFORE, GOOD_AFTER],
    }) as SessionSnapshot;

    const result = parseSessionSnapshot(valid);

    expect(result).toEqual({ ok: true, snapshot: valid, unreadable: [] });
  });

  it('keeps a message whose one part is unreadable, replacing only that part', () => {
    const result = parseSessionSnapshot(
      snapshotWith({
        messages: [
          GOOD_BEFORE,
          {
            id: 'm2',
            role: 'assistant',
            content: 'Let me ask',
            parts: [
              { type: 'text', text: 'Let me ask' },
              { type: 'tool_call', toolName: 'AskUserQuestion' },
            ],
          },
          GOOD_AFTER,
        ],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(result.snapshot.messages[1]!.parts).toEqual([
      { type: 'text', text: 'Let me ask' },
      { type: 'error', message: UNREADABLE_MESSAGE_TEXT },
    ]);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0]!.path).toMatch(/^messages\.1\.parts\.1\./);
  });

  it('replaces a message it cannot salvage with an assistant placeholder in the same position', () => {
    const result = parseSessionSnapshot(
      snapshotWith({
        messages: [GOOD_BEFORE, { id: 'm2', role: 'robot', content: 42 }, GOOD_AFTER],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.messages[0]).toEqual(GOOD_BEFORE);
    expect(result.snapshot.messages[1]).toEqual({
      id: 'm2',
      role: 'assistant',
      content: '',
      parts: [{ type: 'error', message: UNREADABLE_MESSAGE_TEXT }],
    });
    expect(result.snapshot.messages[2]).toEqual(GOOD_AFTER);
  });

  it('drops unreadable pending interactions but keeps the rest of the snapshot', () => {
    const result = parseSessionSnapshot(
      snapshotWith({ messages: [GOOD_BEFORE], pendingInteractions: [{ nope: true }] })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.pendingInteractions).toEqual([]);
    expect(result.snapshot.messages).toEqual([GOOD_BEFORE]);
    expect(result.unreadable[0]!.path).toMatch(/^pendingInteractions\.0/);
  });

  it('turns an unreadable question in the in-progress turn into an inline notice', () => {
    const result = parseSessionSnapshot(
      snapshotWith({
        inProgressTurn: [
          { type: 'turn_start', seq: 4 },
          { type: 'question_prompt', seq: 5, id: 'q1', questions: 'unreadable' },
        ],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.inProgressTurn).toEqual([
      { type: 'turn_start', seq: 4 },
      { type: 'error', seq: 5, message: UNREADABLE_PROMPT_TEXT },
    ]);
  });

  it('still rejects a snapshot whose envelope cannot be read', () => {
    expect(parseSessionSnapshot(snapshotWith({ cursor: 'later' })).ok).toBe(false);
    expect(parseSessionSnapshot({ nope: true }).ok).toBe(false);
    expect(parseSessionSnapshot(null).ok).toBe(false);
  });
});

describe('parseSessionEvent', () => {
  it('passes a valid event through', () => {
    expect(parseSessionEvent({ type: 'turn_start', seq: 1 })).toEqual({
      ok: true,
      event: { type: 'turn_start', seq: 1 },
      unreadable: null,
    });
  });

  it.each(['question_prompt', 'approval_required', 'elicitation_prompt'])(
    'shows an unreadable %s as an inline notice at the same seq',
    (type) => {
      const result = parseSessionEvent({ type, seq: 9, id: 'x' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event).toEqual({ type: 'error', seq: 9, message: UNREADABLE_PROMPT_TEXT });
      expect(result.unreadable?.path.startsWith(type)).toBe(true);
    }
  );

  it('still rejects an unreadable non-prompt event', () => {
    expect(parseSessionEvent({ type: 'text_delta', seq: 2 }).ok).toBe(false);
  });

  it('rejects an unreadable prompt with no usable seq', () => {
    expect(parseSessionEvent({ type: 'question_prompt', id: 'q' }).ok).toBe(false);
  });
});

describe('createUnreadableSnapshotReporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once per session, and never for a clean snapshot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = createUnreadableSnapshotReporter('Test');
    const entry = { path: 'messages.1', message: 'bad' };

    report('a', []);
    report('a', [entry]);
    report('a', [entry]);
    report('b', [entry]);

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
