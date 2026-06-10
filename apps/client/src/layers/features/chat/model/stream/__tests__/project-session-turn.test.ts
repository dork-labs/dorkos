import { describe, it, expect } from 'vitest';
import type { HistoryMessage, PendingInteractionDTO } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { projectInProgressTurn, projectSessionMessages } from '../project-session-turn';

describe('projectInProgressTurn', () => {
  it('coalesces consecutive text_delta events into a single text part', () => {
    // Purpose: streamed token deltas must render as one contiguous text part,
    // matching the live pipeline's text coalescing.
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'Hello ' },
      { seq: 2, type: 'text_delta', text: 'World' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toEqual([{ type: 'text', text: 'Hello World' }]);
  });

  it('starts a new text part after a non-text part interrupts the stream', () => {
    // Purpose: text before and after a tool call must not merge across the tool
    // boundary (mirrors part ordering in the live pipeline).
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'before' },
      { seq: 2, type: 'tool_call', toolCallId: 'tc1', toolName: 'Read', status: 'running' },
      { seq: 3, type: 'text_delta', text: 'after' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'text']);
    expect((parts[2] as { text: string }).text).toBe('after');
  });

  it('pairs a tool_call with its later tool_result onto one tool-call part', () => {
    // Purpose: a tool invocation and its result must collapse to a single
    // tool-call part carrying both input and result with a complete status.
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'tool_call',
        toolCallId: 'tc1',
        toolName: 'Read',
        input: '{"path":"/x"}',
        status: 'running',
      },
      {
        seq: 2,
        type: 'tool_result',
        toolCallId: 'tc1',
        toolName: 'Read',
        result: 'file body',
        status: 'complete',
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'tc1',
      input: '{"path":"/x"}',
      result: 'file body',
      status: 'complete',
    });
  });

  it('surfaces an approval_required interaction as a pending tool-call part', () => {
    // Purpose: a recovered approval must render as a pending, interactive
    // tool-call part the InteractiveInputPanel can drive.
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'approval_required',
        id: 'tc1',
        toolName: 'Bash',
        input: 'rm -rf /tmp/x',
        startedAt: 1000,
        remainingMs: 25000,
        hasSuggestions: false,
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'tc1',
      toolName: 'Bash',
      interactiveType: 'approval',
      status: 'pending',
      approvalStartedAt: 1000,
      approvalRemainingMs: 25000,
    });
  });

  it('surfaces a question_prompt interaction as a pending question tool-call part', () => {
    // Purpose: a recovered AskUserQuestion must render as a pending question
    // tool-call part carrying its questions.
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'question_prompt',
        id: 'q1',
        startedAt: 2000,
        remainingMs: 30000,
        questions: [
          { header: 'a', question: 'Pick one', options: [{ label: 'X' }], multiSelect: false },
        ],
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'q1',
      toolName: 'AskUserQuestion',
      interactiveType: 'question',
      status: 'pending',
    });
    expect((parts[0] as { questions: unknown[] }).questions).toHaveLength(1);
  });

  it('surfaces an elicitation_prompt interaction as a pending elicitation part', () => {
    // Purpose: a recovered MCP elicitation must render as a pending elicitation
    // part keyed by interactionId.
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'elicitation_prompt',
        id: 'e1',
        serverName: 'github',
        message: 'Authorize?',
        startedAt: 3000,
        remainingMs: 60000,
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts[0]).toMatchObject({
      type: 'elicitation',
      interactionId: 'e1',
      serverName: 'github',
      status: 'pending',
    });
  });

  it('maps subagent_update onto a background_task part', () => {
    // Purpose: a subagent update must render as a background_task part so the
    // background task bar reflects the hydrated subagent.
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'subagent_update',
        taskId: 't1',
        status: 'running',
        description: 'Explore repo',
        toolUses: 3,
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts[0]).toMatchObject({
      type: 'background_task',
      taskId: 't1',
      taskType: 'agent',
      status: 'running',
      description: 'Explore repo',
      toolUses: 3,
    });
  });

  it('skips turn_start / turn_end / status_change / todo_update (no renderable part)', () => {
    // Purpose: lifecycle and status events drive the projection/status bar, not
    // the assistant bubble, so they produce no parts.
    const events: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      {
        seq: 2,
        type: 'status_change',
        status: { lifecycle: 'streaming', permissionMode: 'default' },
      },
      {
        seq: 3,
        type: 'todo_update',
        action: 'snapshot',
        task: { id: 'x', subject: 'do', status: 'pending' },
      },
      { seq: 4, type: 'turn_end' },
    ];
    expect(projectInProgressTurn(events)).toEqual([]);
  });
});

describe('projectSessionMessages', () => {
  const history: HistoryMessage[] = [
    { id: 'h1', role: 'user', content: 'Question', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'h2', role: 'assistant', content: 'Answer', timestamp: '2026-01-01T00:00:01Z' },
  ];

  it('returns just the mapped history when the in-progress turn is empty', () => {
    // Purpose: an idle session renders only its completed history — no synthetic
    // trailing assistant bubble.
    const messages = projectSessionMessages(history, []);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual(['h1', 'h2']);
  });

  it('renders the optimistic user message after history and before the in-progress bubble', () => {
    // Purpose (DOR-74): the just-sent user message has no /events event and is not
    // yet in the snapshot, so the projection must render it from
    // optimisticUserMessage — positioned AFTER completed history and BEFORE the
    // streaming assistant bubble.
    const messages = projectSessionMessages(
      history,
      [
        { seq: 1, type: 'turn_start' },
        { seq: 2, type: 'text_delta', text: 'Reply' },
      ],
      [],
      { id: 'opt-1', content: 'New question' }
    );
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2].id).toBe('__optimistic_user__');
    expect(messages[2].content).toBe('New question');
    expect(messages[3].role).toBe('assistant');
    expect(messages[3].content).toBe('Reply');
  });

  it('renders the optimistic user message alone when no turn has started yet', () => {
    // Purpose (DOR-74): immediately after the POST the user bubble must show even
    // before the first /events frame arrives (no assistant bubble yet).
    const messages = projectSessionMessages(history, [], [], {
      id: 'opt-1',
      content: 'New question',
    });
    expect(messages).toHaveLength(3);
    expect(messages[2].id).toBe('__optimistic_user__');
    expect(messages[2].content).toBe('New question');
  });

  it('appends a trailing in-progress assistant bubble for a text-only turn', () => {
    // Purpose: an in-progress turn renders as one trailing assistant message
    // after the completed history, without synthesizing a user message.
    const messages = projectSessionMessages(history, [
      { seq: 1, type: 'turn_start' },
      { seq: 2, type: 'text_delta', text: 'Streaming…' },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe('assistant');
    expect(messages[2].content).toBe('Streaming…');
    expect(messages[2]._streaming).toBe(true);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('does not append a bubble when the in-progress turn has no renderable parts', () => {
    // Purpose: a turn that has only started (turn_start, no output yet) must not
    // render an empty assistant bubble.
    const messages = projectSessionMessages(history, [{ seq: 1, type: 'turn_start' }]);
    expect(messages).toHaveLength(2);
  });

  const recoveredApproval: PendingInteractionDTO = {
    type: 'approval',
    id: 'rec-1',
    startedAt: 1000,
    remainingMs: 20000,
    toolName: 'Bash',
    input: 'ls',
    hasSuggestions: false,
  };

  it('renders a recovered pending interaction when the in-progress turn is empty', () => {
    // Purpose: a session blocked after turn_end clears its inProgressTurn, so the
    // recoverable approval lives ONLY in pendingInteractions. It must still emit a
    // trailing assistant bubble carrying the pending tool-call part — never a user
    // message (regressing this would hide the Approve/Deny card on refresh).
    const messages = projectSessionMessages(history, [], [recoveredApproval]);
    expect(messages).toHaveLength(3);
    const carrier = messages[2];
    expect(carrier.role).toBe('assistant');
    expect(carrier.parts?.[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'rec-1',
      interactiveType: 'approval',
      status: 'pending',
    });
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('dedups an interaction present in BOTH the turn and pendingInteractions (turn wins)', () => {
    // Purpose: an interaction live in the in-progress turn AND recovered into
    // pendingInteractions must render exactly once — the turn's part is kept.
    const turnApproval: SessionEvent = {
      seq: 1,
      type: 'approval_required',
      id: 'rec-1',
      toolName: 'Bash',
      input: 'ls',
      startedAt: 1000,
      remainingMs: 20000,
      hasSuggestions: false,
    };
    const messages = projectSessionMessages(
      history,
      [{ seq: 0, type: 'turn_start' }, turnApproval],
      [recoveredApproval]
    );
    expect(messages).toHaveLength(3);
    const toolCallParts = (messages[2].parts ?? []).filter((p) => p.type === 'tool_call');
    expect(toolCallParts).toHaveLength(1);
    expect(toolCallParts[0]).toMatchObject({ toolCallId: 'rec-1', interactiveType: 'approval' });
  });

  it('upserts a pending DTO onto a BARE tool_call part from the live turn (CLI-C1 regression)', () => {
    // Purpose: during a LIVE turn the `tool_call` event reaches the turn but
    // `approval_required` lands ONLY in pendingInteractions. Treating the bare
    // tool_call part as "already represented" suppressed the Approve/Deny card
    // for every live approval — the session blocked with no operator
    // affordance, and only a refresh (whose snapshot carries the interaction
    // event in the turn) recovered it.
    const liveTurn: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      { seq: 2, type: 'tool_call', toolCallId: 'rec-1', toolName: 'Bash', status: 'pending' },
    ];
    const messages = projectSessionMessages(history, liveTurn, [recoveredApproval]);
    const toolCallParts = (messages[2].parts ?? []).filter((p) => p.type === 'tool_call');
    expect(toolCallParts).toHaveLength(1);
    expect(toolCallParts[0]).toMatchObject({
      toolCallId: 'rec-1',
      interactiveType: 'approval',
      status: 'pending',
    });
  });

  it('interaction_resolved settles a pending part folded from snapshot-carried events', () => {
    // Purpose: a snapshot's inProgressTurn carries the interaction EVENT (which
    // sets interactiveType directly), so removing the pending DTO alone cannot
    // un-pend the part — the resolved event must settle it, or a resolved card
    // keeps rendering with a dead countdown (ghost Approve/Deny).
    const turn: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      { seq: 2, type: 'tool_call', toolCallId: 'rec-1', toolName: 'Bash', status: 'pending' },
      {
        seq: 3,
        type: 'approval_required',
        id: 'rec-1',
        toolName: 'Bash',
        input: 'ls',
        startedAt: 1000,
        remainingMs: 20000,
        hasSuggestions: false,
      },
      { seq: 4, type: 'interaction_resolved', id: 'rec-1', resolution: 'approved' },
    ];
    const parts = projectInProgressTurn(turn);
    expect(parts.filter((p) => p.type === 'tool_call')).toHaveLength(1);
    expect(parts[0]).toMatchObject({ toolCallId: 'rec-1', status: 'running' });
    expect((parts[0] as { approvalRemainingMs?: number }).approvalRemainingMs).toBeUndefined();
  });

  it('interaction_resolved with denied settles the part to error', () => {
    const turn: SessionEvent[] = [
      {
        seq: 1,
        type: 'approval_required',
        id: 'rec-1',
        toolName: 'Bash',
        input: 'ls',
        startedAt: 1000,
        remainingMs: 20000,
        hasSuggestions: false,
      },
      { seq: 2, type: 'interaction_resolved', id: 'rec-1', resolution: 'denied' },
    ];
    const parts = projectInProgressTurn(turn);
    expect(parts[0]).toMatchObject({ toolCallId: 'rec-1', status: 'error' });
  });
});
