// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { HistoryMessage, PendingInteractionDTO } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { projectInProgressTurn, projectSessionMessages } from '../project-session-turn';

describe('projectSessionMessages', () => {
  const history: HistoryMessage[] = [
    { id: 'h1', role: 'user', content: 'Question', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'h2', role: 'assistant', content: 'Answer', timestamp: '2026-01-01T00:00:01Z' },
  ];

  it('renders a steer as an inline user bubble, in reading order, splitting the turn (AC3/AC4)', () => {
    // Purpose (task 4.3): a steer (turn_input) JOINED the open turn — it did not
    // open one — so it renders as a user bubble at the point it arrived, between
    // the assistant text before it and the assistant text after it. It is not a
    // separate turn and must not look like one.
    const messages = projectSessionMessages(history, [
      { seq: 1, type: 'turn_start', userMessage: 'do the thing' },
      { seq: 2, type: 'text_delta', text: 'starting the thing' },
      {
        seq: 3,
        type: 'turn_input',
        content: 'actually, run the tests too',
        disposition: 'steer',
        messageId: 'm-1',
      },
      { seq: 4, type: 'text_delta', text: 'ok, running the tests' },
    ]);
    // history(2) + assistant-before + user-steer + assistant-after
    expect(messages).toHaveLength(5);
    expect(messages.slice(2).map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(messages[2].content).toBe('starting the thing');
    expect(messages[3].id).toBe('steer-m-1');
    expect(messages[3].content).toBe('actually, run the tests too');
    expect(messages[4].content).toBe('ok, running the tests');
    // The trailing (open) segment keeps the stable id; the earlier one does not,
    // so the two bubbles reconcile independently.
    expect(messages[4].id).toBe('__in_progress_turn__');
    expect(messages[2].id).not.toBe('__in_progress_turn__');
  });

  it('renders a staged message as a quiet note, splitting the turn but not as a bubble (task 4.6)', () => {
    // Purpose: staging added context for the NEXT turn without cutting into this
    // one, so it must render as a quiet transcript entry — flagged `_stagedContext`
    // so the list draws it as a note, never a user/assistant message bubble.
    const messages = projectSessionMessages(history, [
      { seq: 1, type: 'turn_start', userMessage: 'do the thing' },
      { seq: 2, type: 'text_delta', text: 'working on it' },
      {
        seq: 3,
        type: 'context_staged',
        content: 'for later: keep the public API stable',
        messageId: 'm-3',
      },
      { seq: 4, type: 'text_delta', text: 'still working' },
    ]);
    // history(2) + assistant-before + staged-note + assistant-after
    expect(messages).toHaveLength(5);
    const note = messages[3];
    expect(note.id).toBe('staged-m-3');
    expect(note.content).toBe('for later: keep the public API stable');
    expect(note._stagedContext).toBe(true);
    // Bracketed by assistant text on both sides, in reading order — the note is
    // not the end of the turn.
    expect(messages[2].content).toBe('working on it');
    expect(messages[4].content).toBe('still working');
    expect(messages[4].id).toBe('__in_progress_turn__');
  });

  it('settles an approval whose answer landed after a steer split the turn', () => {
    // Purpose: a steer arriving between an approval and its answer closes the
    // approval's bubble before the answer folds. Left there, the card stayed
    // "waiting on you" forever, its buttons answered nothing, and the composer
    // stayed hidden behind it until the turn ended.
    const messages = projectSessionMessages(history, [
      { seq: 1, type: 'turn_start', userMessage: 'go' },
      { seq: 2, type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', status: 'running' },
      {
        seq: 3,
        type: 'approval_required',
        id: 'tc-1',
        toolName: 'Bash',
        input: '{}',
        startedAt: 1000,
        remainingMs: 600000,
        hasSuggestions: false,
      },
      { seq: 4, type: 'turn_input', content: 'also do X', disposition: 'steer', messageId: 'm-5' },
      {
        seq: 5,
        type: 'interaction_resolved',
        id: 'tc-1',
        resolution: 'approved',
        at: 2000,
        kind: 'approval',
      },
      { seq: 6, type: 'tool_result', toolCallId: 'tc-1', toolName: 'Bash', status: 'complete' },
    ]);
    const parts = messages.flatMap((m) => m.parts ?? []);
    expect(parts.some((p) => p.type === 'tool_call' && p.status === 'pending')).toBe(false);
    const gated = parts.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-1' && p.interactiveType === 'approval'
    );
    expect(gated).toMatchObject({ approvalOutcome: expect.anything() });
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

  it('takes the countdown from the snapshot DTO, not the replayed ask (DOR-810)', () => {
    // THE RELOAD CASE, and the one the durable stream cannot answer alone. A
    // replayed `approval_required` carries the remainder it had when it was
    // EMITTED — the full budget — so a card rebuilt from the turn alone jumps
    // back to the start of the countdown on every reload. Measured in a browser
    // before this was fixed: a card twenty seconds old came back reading 598
    // of 600. The snapshot's pending DTO is computed at snapshot time and is
    // the only fresh timer in the payload, so it wins even though the turn
    // already represents the interaction.
    const askedAt = 1_700_000_000_000;
    const staleAsk: SessionEvent = {
      seq: 2,
      type: 'approval_required',
      id: 'rec-1',
      toolName: 'Bash',
      input: 'ls',
      startedAt: askedAt,
      remainingMs: 600_000,
      timeoutMs: 600_000,
      hasSuggestions: false,
    };
    const freshDto: PendingInteractionDTO = {
      type: 'approval',
      id: 'rec-1',
      startedAt: askedAt,
      remainingMs: 61_000,
      timeoutMs: 600_000,
      toolName: 'Bash',
      input: 'ls',
      hasSuggestions: false,
    };

    const messages = projectSessionMessages(
      history,
      [{ seq: 1, type: 'turn_start' }, staleAsk],
      [freshDto]
    );
    const parts = (messages[2].parts ?? []).filter((p) => p.type === 'tool_call');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolCallId: 'rec-1',
      interactiveType: 'approval',
      status: 'pending',
      approvalRemainingMs: 61_000,
      approvalStartedAt: askedAt,
      timeoutMs: 600_000,
    });
  });

  it('carries PARKED off the snapshot DTO onto the turn’s own card', () => {
    // THE RELOAD-MID-PARK CASE. A parked DTO ships no `timeoutMs` and a
    // remainder that runs to the four-hour ceiling, while the turn's replayed
    // ask still carries the ten-minute budget. Without the flag the card read
    // that remainder as a countdown against that budget and announced
    // "228:59 remaining" with a draining bar over a prompt the agent was
    // quietly holding.
    const askedAt = 1_700_000_000_000;
    const staleAsk: SessionEvent = {
      seq: 2,
      type: 'approval_required',
      id: 'rec-1',
      toolName: 'Bash',
      input: 'ls',
      startedAt: askedAt,
      remainingMs: 600_000,
      timeoutMs: 600_000,
      hasSuggestions: false,
    };
    const parkedDto: PendingInteractionDTO = {
      type: 'approval',
      id: 'rec-1',
      startedAt: askedAt,
      remainingMs: 4 * 60 * 60_000 - 11 * 60_000,
      parked: true,
      toolName: 'Bash',
      input: 'ls',
      hasSuggestions: false,
    };

    const messages = projectSessionMessages(
      history,
      [{ seq: 1, type: 'turn_start' }, staleAsk],
      [parkedDto]
    );
    const parts = (messages[2].parts ?? []).filter((p) => p.type === 'tool_call');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolCallId: 'rec-1',
      status: 'pending',
      approvalParked: true,
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

  it('leaves an answer the turn already carries alone, even with a stale pending DTO', () => {
    // The same shape as the settle test above, plus the DTO. A snapshot is one
    // instant's copy, so it can still list an interaction the turn has just
    // answered — and re-pending on top of that draws an Approve/Deny card over
    // an edit that has already been applied. The turn's own answer outranks it,
    // which is the rule `foldInteractionResolved` applies to itself.
    const turn: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      { seq: 2, type: 'tool_call', toolCallId: 'rec-1', toolName: 'Edit', status: 'pending' },
      {
        seq: 3,
        type: 'approval_required',
        id: 'rec-1',
        toolName: 'Edit',
        input: '{"file_path":"notes/release.md"}',
        startedAt: 1000,
        remainingMs: 20000,
        hasSuggestions: false,
      },
      { seq: 4, type: 'interaction_resolved', id: 'rec-1', resolution: 'approved' },
      {
        seq: 5,
        type: 'tool_result',
        toolCallId: 'rec-1',
        toolName: 'Edit',
        status: 'complete',
        result: 'Applied 1 edit to notes/release.md',
      },
    ];
    const staleDto: PendingInteractionDTO = {
      type: 'approval',
      id: 'rec-1',
      startedAt: 1000,
      remainingMs: 20000,
      toolName: 'Edit',
      input: '{"file_path":"notes/release.md"}',
      hasSuggestions: false,
    };
    const messages = projectSessionMessages(history, turn, [staleDto]);
    const toolCalls = (messages[2].parts ?? []).filter((p) => p.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolCallId: 'rec-1',
      status: 'complete',
      result: 'Applied 1 edit to notes/release.md',
    });
  });

  it('renders one card, not two, when history already holds the parked tool call', () => {
    // claude-code persists the assistant record the moment the model emits the
    // `tool_use` block, and the transcript parser stamps every such block
    // `complete` — so while a person is being asked, history ALSO holds a
    // finished-looking AskUserQuestion with its questions and no answers, which
    // renders as a green "Question answered". Concatenating that with the live
    // turn put that line directly above the card still waiting to be answered
    // (DOR-1269). The live part wins; the history copy goes.
    const askedHistory: HistoryMessage[] = [
      { id: 'h1', role: 'user', content: 'ask me', timestamp: '2026-01-01T00:00:00Z' },
      {
        id: 'h2',
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T00:00:01Z',
        parts: [
          { type: 'thinking', text: 'deciding what to ask', isStreaming: false },
          {
            type: 'tool_call',
            toolCallId: 'toolu_q1',
            toolName: 'AskUserQuestion',
            input: '{}',
            status: 'complete',
            interactiveType: 'question',
            questions: [
              {
                header: 'Runner',
                question: 'Which?',
                options: [{ label: 'Vitest' }],
                multiSelect: false,
              },
            ],
          },
        ],
      },
    ];
    const turn: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      {
        seq: 2,
        type: 'tool_call',
        toolCallId: 'toolu_q1',
        toolName: 'AskUserQuestion',
        input: '{}',
        status: 'running',
      },
    ];
    const messages = projectSessionMessages(askedHistory, turn, [
      {
        type: 'question',
        id: 'toolu_q1',
        startedAt: 1000,
        remainingMs: 500_000,
        questions: [
          {
            header: 'Runner',
            question: 'Which?',
            options: [{ label: 'Vitest' }],
            multiSelect: false,
          },
        ],
      },
    ]);
    const questionParts = messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.type === 'tool_call' && p.toolCallId === 'toolu_q1');
    expect(questionParts).toHaveLength(1);
    expect(questionParts[0]).toMatchObject({ interactiveType: 'question', status: 'pending' });
    // The rest of the history message survives — only the duplicate goes.
    expect((messages[1].parts ?? []).map((p) => p.type)).toEqual(['thinking']);
  });

  it('keeps an earlier turn’s finished call when a later turn reuses its id (codex)', () => {
    // TOOL CALL IDS ARE NOT SESSION-UNIQUE. codex passes the SDK's raw item id
    // through and opens a fresh thread per turn, so turn 2 starts counting at
    // '0' again — as do the codex fixtures, and as do the test-mode scenarios,
    // which re-run with the same literal ids every turn. Deduping on an id match
    // alone would delete a real, finished call out of the transcript the moment
    // a new turn happened to reuse its number.
    const reusedId = '0';
    const priorTurn: HistoryMessage[] = [
      { id: 'h1', role: 'user', content: 'read the file', timestamp: '2026-01-01T00:00:00Z' },
      {
        id: 'h2',
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T00:00:01Z',
        parts: [
          {
            type: 'tool_call',
            toolCallId: reusedId,
            toolName: 'Read',
            input: '{"path":"a.ts"}',
            status: 'complete',
            result: 'export const a = 1;',
          },
        ],
      },
    ];
    const turnTwo: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      {
        seq: 2,
        type: 'tool_call',
        toolCallId: reusedId,
        toolName: 'Edit',
        input: '{"path":"b.ts"}',
        status: 'running',
      },
      {
        seq: 3,
        type: 'approval_required',
        id: reusedId,
        toolName: 'Edit',
        input: '{"path":"b.ts"}',
        startedAt: 1000,
        remainingMs: 600_000,
        hasSuggestions: false,
      },
    ];
    const messages = projectSessionMessages(priorTurn, turnTwo, [
      {
        type: 'approval',
        id: reusedId,
        startedAt: 1000,
        remainingMs: 540_000,
        toolName: 'Edit',
        input: '{"path":"b.ts"}',
        hasSuggestions: false,
      },
    ]);
    const toolParts = messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.type === 'tool_call' && p.toolCallId === reusedId);
    // BOTH survive: the finished read from turn 1, and the pending edit in turn 2.
    expect(toolParts).toHaveLength(2);
    expect(toolParts[0]).toMatchObject({ toolName: 'Read', result: 'export const a = 1;' });
    expect(toolParts[1]).toMatchObject({ toolName: 'Edit', status: 'pending' });
  });
});
