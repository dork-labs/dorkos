import { describe, it, expect, beforeEach } from 'vitest';
import type { PendingInteractionDTO, QuestionItem } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';
import { useSessionStreamStore } from '@/layers/entities/session';
import { selectRenderedMessages } from '../derive-rendered-state';

const SID = 'sess-blocked';

/** A session parked on an operator decision, as a cold snapshot reports it. */
const BLOCKED_STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'blocked',
  lastError: null,
};

const QUESTIONS: QuestionItem[] = [
  {
    header: 'Test runner',
    question: 'Which test runner should I set up?',
    options: [{ label: 'Vitest' }, { label: 'Jest' }],
    multiSelect: false,
  },
];

function snapshot(
  inProgressTurn: SessionEvent[],
  pendingInteractions: PendingInteractionDTO[]
): SessionSnapshot {
  return {
    messages: [{ id: 'u1', role: 'user', content: 'go ahead' }],
    inProgressTurn,
    status: BLOCKED_STATUS,
    pendingInteractions,
    queuedMessages: [],
    cursor: 42,
  };
}

/**
 * The scan that decides whether the composer offers a way to answer: the same
 * `interactiveType && status === 'pending'` filter `useChatSession` runs to
 * produce `activeInteraction`.
 */
function answerable(sessionId: string): string[] {
  const stream = useSessionStreamStore.getState().getSession(sessionId);
  return selectRenderedMessages(stream, [])
    .flatMap((m) => m.toolCalls ?? [])
    .filter((tc) => tc.interactiveType && tc.status === 'pending')
    .map((tc) => tc.toolCallId);
}

describe('selectRenderedMessages — a prompt parked across a hard refresh (DOR-1269)', () => {
  beforeEach(() => {
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  });

  // The shape a cold hydrate actually meets, and the reason this suite exists.
  //
  // The LIVE store keeps `approval_required` / `question_prompt` /
  // `elicitation_prompt` OUT of `inProgressTurn` — they go straight to
  // `pendingInteractions` — so live, the pending fold runs LAST and owns the
  // hold. A cold snapshot's `inProgressTurn` comes from the SERVER projector,
  // which does hold them, so the fold runs mid-turn instead. claude-code emits
  // `tool_call_end` → `tool_result` at `content_block_stop` (the model finished
  // streaming the tool's input; the gated tool has not run), so a `complete`
  // status lands on the same part AFTER the ask. Before the fix that overwrote
  // the hold, the card rendered as an answered receipt, and the scan above went
  // blind — a blocked session no window could move forward.
  const gatedToolTurn = (id: string, toolName: string, ask: SessionEvent): SessionEvent[] => [
    { seq: 1, type: 'turn_start' },
    { seq: 2, type: 'tool_call', toolCallId: id, toolName, input: '{}', status: 'running' },
    ask,
    { seq: 4, type: 'tool_result', toolCallId: id, toolName, status: 'complete' },
  ];

  it('keeps a question answerable when the turn replay reports its tool complete', () => {
    const id = 'toolu_question_1';
    useSessionStreamStore.getState().applySnapshot(
      SID,
      snapshot(
        gatedToolTurn(id, 'AskUserQuestion', {
          seq: 3,
          type: 'question_prompt',
          id,
          startedAt: 1000,
          remainingMs: 600_000,
          questions: QUESTIONS,
        }),
        [{ type: 'question', id, startedAt: 1000, remainingMs: 540_000, questions: QUESTIONS }]
      )
    );
    expect(answerable(SID)).toEqual([id]);
  });

  it('keeps a tool approval answerable when the turn replay reports its tool complete', () => {
    const id = 'toolu_approval_1';
    useSessionStreamStore.getState().applySnapshot(
      SID,
      snapshot(
        gatedToolTurn(id, 'Edit', {
          seq: 3,
          type: 'approval_required',
          id,
          toolName: 'Edit',
          input: '{"file_path":"notes/release.md"}',
          startedAt: 1000,
          remainingMs: 600_000,
          hasSuggestions: false,
        }),
        [
          {
            type: 'approval',
            id,
            startedAt: 1000,
            remainingMs: 540_000,
            toolName: 'Edit',
            input: '{"file_path":"notes/release.md"}',
            hasSuggestions: false,
          },
        ]
      )
    );
    expect(answerable(SID)).toEqual([id]);
  });

  it('keeps every ask of a batch answerable, not just the last one', () => {
    // The batch bar mounts at two or more pending. One un-pended ask is enough
    // to drop the count below it, so the bar is only honest if all of them
    // survive hydration.
    const ids = ['toolu_batch_1', 'toolu_batch_2'];
    const turn: SessionEvent[] = [{ seq: 1, type: 'turn_start' }];
    let seq = 2;
    for (const id of ids) {
      turn.push({
        seq: seq++,
        type: 'tool_call',
        toolCallId: id,
        toolName: 'Edit',
        status: 'running',
      });
      turn.push({
        seq: seq++,
        type: 'approval_required',
        id,
        toolName: 'Edit',
        input: '{}',
        startedAt: 1000,
        remainingMs: 600_000,
        hasSuggestions: false,
      });
      turn.push({
        seq: seq++,
        type: 'tool_result',
        toolCallId: id,
        toolName: 'Edit',
        status: 'complete',
      });
    }
    useSessionStreamStore.getState().applySnapshot(
      SID,
      snapshot(
        turn,
        ids.map((id) => ({
          type: 'approval' as const,
          id,
          startedAt: 1000,
          remainingMs: 540_000,
          toolName: 'Edit',
          input: '{}',
          hasSuggestions: false,
        }))
      )
    );
    expect(answerable(SID)).toEqual(ids);
  });

  it('does not put an already-submitted elicitation back in front of the person', () => {
    // The OTHER half of the rule, and the reason the re-assert is not blanket.
    // An elicitation part cannot be un-pended by anything — no `tool_result`
    // reaches one, and its only two status writers are the ask (pending) and the
    // resolution (submitted) — so a hold to restore never exists here, while a
    // DTO that outlived its own resolution by one snapshot certainly can. The
    // countdown is still taken; the status is not.
    const id = 'elicit-1';
    useSessionStreamStore.getState().applySnapshot(
      SID,
      snapshot(
        [
          { seq: 1, type: 'turn_start' },
          {
            seq: 2,
            type: 'elicitation_prompt',
            id,
            serverName: 'deploy-tools',
            message: 'Which environment?',
            startedAt: 1000,
            remainingMs: 600_000,
          },
          { seq: 3, type: 'interaction_resolved', id, resolution: 'answered' },
        ],
        [
          {
            type: 'elicitation',
            id,
            startedAt: 1000,
            remainingMs: 540_000,
            serverName: 'deploy-tools',
            message: 'Which environment?',
          },
        ]
      )
    );
    const stream = useSessionStreamStore.getState().getSession(SID);
    const parts = selectRenderedMessages(stream, []).flatMap((m) => m.parts);
    expect(parts.filter((p) => p.type === 'elicitation')).toEqual([
      expect.objectContaining({ interactionId: id, status: 'submitted' }),
    ]);
  });
});
