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

  // A cold mid-turn snapshot's `inProgressTurn` (copied verbatim from the server
  // projector) CAN contain a `ui_command` — it is an imperative side-effect
  // member, not a renderable part (DOR-104). It must produce no part and, unlike
  // a tool_call, must NOT interrupt text coalescing (the `default` arm folds
  // nothing, so the prior text part stays open). A future exhaustive-switch
  // refactor that dropped the `default` arm would silently regress this.
  it('ignores a ui_command in inProgressTurn without breaking text coalescing', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'Hello ' },
      {
        seq: 2,
        type: 'ui_command',
        command: { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } },
      },
      { seq: 3, type: 'text_delta', text: 'World' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toEqual([{ type: 'text', text: 'Hello World' }]);
  });

  it('produces no assistant part for a ui_command-only turn', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'ui_command', command: { action: 'close_canvas' } },
    ];
    expect(projectInProgressTurn(events)).toEqual([]);
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

  it('carries an MCP App ui reference from tool_result onto the tool-call part', () => {
    // Purpose: the inline MCP-App renderer keys off `ui` on the tool-call part,
    // so the ui:// reference must fold from the terminal tool_result (§2.3).
    const events: SessionEvent[] = [
      { seq: 1, type: 'tool_call', toolCallId: 'tc1', toolName: 'mcp__app__x', status: 'running' },
      {
        seq: 2,
        type: 'tool_result',
        toolCallId: 'tc1',
        toolName: 'mcp__app__x',
        result: 'ready',
        status: 'complete',
        ui: { resourceUri: 'ui://dash/main' },
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts[0]).toMatchObject({ type: 'tool_call', ui: { resourceUri: 'ui://dash/main' } });
  });

  it('surfaces an approval_required interaction as a pending tool-call part', () => {
    // Purpose: a recovered approval must render as a pending, interactive
    // tool-call part `SessionAsks` can drive.
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

  it('carries the approval timeout onto the part, so the card can count down', () => {
    // Purpose: the countdown and the draining progress bar are both gated on
    // `timeoutMs`. The stream carries the server's own auto-deny budget; a part
    // folded without it renders a card with no deadline anywhere on it.
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'approval_required',
        id: 'tc1',
        toolName: 'Bash',
        input: 'rm -rf /tmp/x',
        startedAt: 1000,
        remainingMs: 25000,
        timeoutMs: 600_000,
        hasSuggestions: false,
      },
    ];
    expect(projectInProgressTurn(events)[0]).toMatchObject({ timeoutMs: 600_000 });
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

  it('upserts repeated tool_call events for one id, appending input fragments', () => {
    // Real failure mode: the adapter's tool_call_start AND each streamed
    // input_json_delta fragment all normalize to `tool_call` — pushing a part
    // per event rendered one duplicate tool part per fragment, with only the
    // last one settling on tool_result.
    const events: SessionEvent[] = [
      { seq: 1, type: 'tool_call', toolCallId: 'tc1', toolName: 'Bash', status: 'running' },
      {
        seq: 2,
        type: 'tool_call',
        toolCallId: 'tc1',
        toolName: 'Bash',
        input: '{"command":',
        status: 'running',
      },
      {
        seq: 3,
        type: 'tool_call',
        toolCallId: 'tc1',
        toolName: 'Bash',
        input: '"ls"}',
        status: 'running',
      },
      {
        seq: 4,
        type: 'tool_result',
        toolCallId: 'tc1',
        toolName: 'Bash',
        result: 'ok',
        status: 'complete',
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'tc1',
      input: '{"command":"ls"}',
      result: 'ok',
      status: 'complete',
    });
  });

  it('coalesces thinking_delta events into one streaming thinking part', () => {
    // Purpose (task #19): live thinking must render as a single streaming
    // thinking block, exactly like the legacy in-band pipeline.
    const events: SessionEvent[] = [
      { seq: 1, type: 'thinking_delta', text: 'Let me ' },
      { seq: 2, type: 'thinking_delta', text: 'reason…' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toEqual([{ type: 'thinking', text: 'Let me reason…', isStreaming: true }]);
  });

  it('finalizes the streaming thinking part when assistant text begins', () => {
    // Purpose (task #19): the first text_delta after thinking ends the thinking
    // phase — without this the block never auto-collapses during a live turn.
    const events: SessionEvent[] = [
      { seq: 1, type: 'thinking_delta', text: 'hmm' },
      { seq: 2, type: 'text_delta', text: 'Answer' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toEqual([
      { type: 'thinking', text: 'hmm', isStreaming: false },
      { type: 'text', text: 'Answer' },
    ]);
  });

  it('appends tool_progress deltas to the tool part and clears them on tool_result', () => {
    // Purpose (task #19): live Bash output must accumulate on the running tool
    // part, then be superseded by the terminal result (legacy parity).
    const events: SessionEvent[] = [
      { seq: 1, type: 'tool_call', toolCallId: 'tc1', toolName: 'Bash', status: 'running' },
      { seq: 2, type: 'tool_progress', toolCallId: 'tc1', content: 'line 1\n' },
      { seq: 3, type: 'tool_progress', toolCallId: 'tc1', content: 'line 2\n' },
    ];
    const running = projectInProgressTurn(events);
    expect(running[0]).toMatchObject({ toolCallId: 'tc1', progressOutput: 'line 1\nline 2\n' });

    const settled = projectInProgressTurn([
      ...events,
      {
        seq: 4,
        type: 'tool_result',
        toolCallId: 'tc1',
        toolName: 'Bash',
        result: 'ok',
        status: 'complete',
      },
    ]);
    expect(settled[0]).toMatchObject({ toolCallId: 'tc1', result: 'ok', status: 'complete' });
    expect((settled[0] as { progressOutput?: string }).progressOutput).toBeUndefined();
  });

  it('drops a tool_progress delta for an unknown toolCallId', () => {
    // Purpose: a progress delta whose tool part never folded must not crash or
    // synthesize a part (mirrors the legacy warn-and-skip).
    const parts = projectInProgressTurn([
      { seq: 1, type: 'tool_progress', toolCallId: 'ghost', content: 'x' },
    ]);
    expect(parts).toEqual([]);
  });

  it('attaches hook_update lifecycle to its tool part and merges later phases', () => {
    // Purpose (task #19): a hook's started → progress → response phases must
    // merge onto ONE HookPart under the tool part, ending settled with exitCode.
    const events: SessionEvent[] = [
      { seq: 1, type: 'tool_call', toolCallId: 'tc1', toolName: 'Edit', status: 'running' },
      {
        seq: 2,
        type: 'hook_update',
        hookId: 'h1',
        status: 'running',
        hookName: 'lint',
        hookEvent: 'PostToolUse',
        toolCallId: 'tc1',
      },
      {
        seq: 3,
        type: 'hook_update',
        hookId: 'h1',
        status: 'running',
        stdout: 'checking…',
        stderr: '',
      },
      {
        seq: 4,
        type: 'hook_update',
        hookId: 'h1',
        status: 'error',
        hookName: 'lint',
        stdout: 'checking…',
        stderr: 'boom',
        exitCode: 2,
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toHaveLength(1);
    const hooks = (parts[0] as { hooks?: unknown[] }).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks?.[0]).toMatchObject({
      hookId: 'h1',
      hookName: 'lint',
      hookEvent: 'PostToolUse',
      status: 'error',
      stdout: 'checking…',
      stderr: 'boom',
      exitCode: 2,
    });
  });

  it('buffers a hook_update that precedes its tool_call and drains it onto the part', () => {
    // Purpose (task #19): hook_started can arrive before tool_call_start in the
    // adapter stream — the orphan buffer must hold it until the part appears
    // (legacy orphanHooksRef parity).
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'hook_update',
        hookId: 'h1',
        status: 'running',
        hookName: 'guard',
        hookEvent: 'PreToolUse',
        toolCallId: 'tc1',
      },
      { seq: 2, type: 'tool_call', toolCallId: 'tc1', toolName: 'Bash', status: 'running' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toHaveLength(1);
    expect((parts[0] as { hooks?: unknown[] }).hooks?.[0]).toMatchObject({
      hookId: 'h1',
      hookName: 'guard',
      status: 'running',
    });
  });

  it('drops a session-level hook_update (no toolCallId) without a renderable part', () => {
    const parts = projectInProgressTurn([
      {
        seq: 1,
        type: 'hook_update',
        hookId: 'h1',
        status: 'running',
        hookName: 'session',
        hookEvent: 'SessionStart',
        toolCallId: null,
      },
    ]);
    expect(parts).toEqual([]);
  });

  it('pins the memory_recall part at index 0 and dedupes replayed paths', () => {
    // Purpose (task #19): memory recall renders as one collapsible block pinned
    // above the turn's output; a replayed batch must not duplicate entries
    // (first-writer-wins per path, legacy upsertMemoryRecallPart parity).
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'Working…' },
      {
        seq: 2,
        type: 'memory_recall',
        mode: 'select',
        memories: [{ path: '/m/a.md', scope: 'personal' }],
      },
      {
        seq: 3,
        type: 'memory_recall',
        mode: 'select',
        memories: [
          { path: '/m/a.md', scope: 'personal' },
          { path: '/m/b.md', scope: 'team' },
        ],
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts.map((p) => p.type)).toEqual(['memory_recall', 'text']);
    expect(parts[0]).toMatchObject({
      type: 'memory_recall',
      mode: 'select',
      isStreaming: true,
      memories: [
        { path: '/m/a.md', scope: 'personal' },
        { path: '/m/b.md', scope: 'team' },
      ],
    });
  });

  it('folds a compact_boundary into an inline compaction row part (DOR-118)', () => {
    // Purpose: a successful compaction renders as a row carrying the SDK
    // compact_metadata (pre/post tokens + trigger) after the turn's text.
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'before' },
      {
        seq: 2,
        type: 'compact_boundary',
        trigger: 'manual',
        preTokens: 52000,
        postTokens: 8000,
        durationMs: 1200,
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts.map((p) => p.type)).toEqual(['text', 'compact_boundary']);
    expect(parts[1]).toEqual({
      type: 'compact_boundary',
      trigger: 'manual',
      preTokens: 52000,
      postTokens: 8000,
      durationMs: 1200,
    });
  });

  it('synthesizes a failed compaction row from operation_progress state:failed (DOR-110)', () => {
    // Purpose: a failed compaction fires NO compact_boundary, so its only durable
    // signal is operation_progress — surface that inline as a failed row + error.
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'operation_progress',
        operation: 'compaction',
        state: 'failed',
        determinate: false,
        error: 'summarization failed',
      },
    ];
    expect(projectInProgressTurn(events)).toEqual([
      { type: 'compact_boundary', failed: true, error: 'summarization failed' },
    ]);
  });

  it('folds a typed error event into an inline error part', () => {
    // Purpose: a live typed error must render the inline ErrorMessageBlock for
    // every runtime — previously error events never reached the client at all.
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'partial output' },
      { seq: 2, type: 'error', message: 'Model overloaded', category: 'execution_error' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toEqual([
      { type: 'text', text: 'partial output' },
      { type: 'error', message: 'Model overloaded', category: 'execution_error' },
    ]);
  });

  it('an error event finalizes a streaming thinking block (foldTextDelta parity)', () => {
    // Purpose: an error ends the thinking phase like assistant text does —
    // without this the block would spin as "thinking" under the failure.
    const events: SessionEvent[] = [
      { seq: 1, type: 'thinking_delta', text: 'hmm' },
      { seq: 2, type: 'error', message: 'boom' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts).toEqual([
      { type: 'thinking', text: 'hmm', isStreaming: false },
      { type: 'error', message: 'boom' },
    ]);
  });

  it('folds the error code into the details string — [code] prefix, event-log-history parity', () => {
    // Purpose: ErrorPart carries no `code` field, so the code folds into
    // details exactly as the server's event-log-history.ts does — the live
    // part must match the post-turn history reload byte-for-byte.
    const withBoth = projectInProgressTurn([
      { seq: 1, type: 'error', message: 'm', code: 'overloaded_error', details: 'HTTP 529' },
    ]);
    expect(withBoth).toEqual([
      { type: 'error', message: 'm', details: '[overloaded_error] HTTP 529' },
    ]);

    const codeOnly = projectInProgressTurn([
      { seq: 1, type: 'error', message: 'm', code: 'overloaded_error' },
    ]);
    expect(codeOnly).toEqual([{ type: 'error', message: 'm', details: '[overloaded_error]' }]);

    const detailsOnly = projectInProgressTurn([
      { seq: 1, type: 'error', message: 'm', details: 'HTTP 529' },
    ]);
    expect(detailsOnly).toEqual([{ type: 'error', message: 'm', details: 'HTTP 529' }]);
  });

  it('skips turn_start / turn_end / status_change / todo_update / system_status / non-failed operation_progress', () => {
    // Purpose: lifecycle and status events drive the projection/status bar, not
    // the assistant bubble, so they produce no parts. A compaction start
    // (operation_progress started) and its done resolution drive the strip, not
    // the transcript; a system_status hook flash likewise renders no bubble part.
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
      { seq: 4, type: 'system_status', message: 'Running hook "fmt"…' },
      {
        seq: 5,
        type: 'operation_progress',
        operation: 'compaction',
        state: 'started',
        determinate: false,
        message: 'Compacting context…',
      },
      {
        seq: 6,
        type: 'operation_progress',
        operation: 'compaction',
        state: 'done',
        determinate: false,
      },
      { seq: 7, type: 'turn_end' },
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

  it('renders a steer even when it arrives before any assistant output', () => {
    // Purpose: a steer that lands before the agent has said anything still shows,
    // and does not manufacture an empty assistant bubble ahead of it.
    const messages = projectSessionMessages(history, [
      { seq: 1, type: 'turn_start', userMessage: 'go' },
      {
        seq: 2,
        type: 'turn_input',
        content: 'wait, do it this way',
        disposition: 'steer',
        messageId: 'm-2',
      },
      { seq: 3, type: 'text_delta', text: 'doing it that way' },
    ]);
    expect(messages.slice(2).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[2].id).toBe('steer-m-2');
    expect(messages[3].content).toBe('doing it that way');
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

  it('does not tag an ordinary steer as staged context', () => {
    // Guards the split's discriminator: a steer is a user bubble, a stage is a
    // quiet note — the projector must not confuse the two.
    const messages = projectSessionMessages(history, [
      { seq: 1, type: 'turn_start', userMessage: 'go' },
      { seq: 2, type: 'turn_input', content: 'also do X', disposition: 'steer', messageId: 'm-4' },
    ]);
    expect(messages[2].id).toBe('steer-m-4');
    expect(messages[2]._stagedContext).toBeUndefined();
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
    expect(parts[0]).toMatchObject({ toolCallId: 'rec-1', status: 'pending', approvalParked: true });
  });

  it('carries PARKED onto a card the turn does not represent at all', () => {
    // The other recovery shape: the turn was cleared, so the card is built from
    // the DTO alone. It must arrive parked too, or the same prompt reads one way
    // after a reload and another after a reload that lost the turn.
    const parkedDto: PendingInteractionDTO = {
      type: 'approval',
      id: 'rec-alone',
      startedAt: 1000,
      remainingMs: 4 * 60 * 60_000 - 11 * 60_000,
      parked: true,
      toolName: 'Bash',
      input: 'ls',
      hasSuggestions: false,
    };

    const messages = projectSessionMessages(history, [], [parkedDto]);
    const parts = (messages[2].parts ?? []).filter((p) => p.type === 'tool_call');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ toolCallId: 'rec-alone', approvalParked: true });
    expect((parts[0] as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });

  it('leaves a prompt still inside its budget unparked', () => {
    const messages = projectSessionMessages(history, [], [recoveredApproval]);
    const parts = (messages[2].parts ?? []).filter((p) => p.type === 'tool_call');
    expect((parts[0] as { approvalParked?: boolean }).approvalParked).toBeUndefined();
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

  it('leaves a submitted elicitation alone, even with a stale pending DTO', () => {
    // Nothing can un-pend an elicitation part — no `tool_result` reaches one, and
    // its only two status writers are the ask (pending) and the resolution
    // (submitted). So the recovery fold has no hold to restore here, and the one
    // thing a re-assert could do is put a form somebody already submitted back
    // in front of them.
    const turn: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      {
        seq: 2,
        type: 'elicitation_prompt',
        id: 'elicit-1',
        serverName: 'deploy-tools',
        message: 'Which environment?',
        startedAt: 1000,
        remainingMs: 20000,
      },
      { seq: 3, type: 'interaction_resolved', id: 'elicit-1', resolution: 'answered' },
    ];
    const staleDto: PendingInteractionDTO = {
      type: 'elicitation',
      id: 'elicit-1',
      startedAt: 1000,
      remainingMs: 20000,
      serverName: 'deploy-tools',
      message: 'Which environment?',
    };
    const messages = projectSessionMessages(history, turn, [staleDto]);
    const elicitations = (messages[2].parts ?? []).filter((p) => p.type === 'elicitation');
    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toMatchObject({ interactionId: 'elicit-1', status: 'submitted' });
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

  it("keeps an earlier turn's finished call when a later turn reuses its id (codex)", () => {
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

  it('keeps an answered question when the next turn reuses its id (test-mode)', () => {
    // The test-mode scenarios re-run per turn with the same literal ids
    // ('question-1', 'gated-edit-1', 'batch-*'), so a second ask in the same
    // session collides with the answered one already in history. `answers` is
    // what marks that one as real.
    const answeredHistory: HistoryMessage[] = [
      { id: 'h1', role: 'user', content: 'set up tests', timestamp: '2026-01-01T00:00:00Z' },
      {
        id: 'h2',
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T00:00:01Z',
        parts: [
          {
            type: 'tool_call',
            toolCallId: 'question-1',
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
            answers: { '0': 'Vitest' },
          },
        ],
      },
    ];
    const secondAsk: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      {
        seq: 2,
        type: 'tool_call',
        toolCallId: 'question-1',
        toolName: 'AskUserQuestion',
        input: '{}',
        status: 'running',
      },
    ];
    const messages = projectSessionMessages(answeredHistory, secondAsk, [
      {
        type: 'question',
        id: 'question-1',
        startedAt: 1000,
        remainingMs: 500_000,
        questions: [
          {
            header: 'Coverage',
            question: 'Enable it?',
            options: [{ label: 'Yes' }],
            multiSelect: false,
          },
        ],
      },
    ]);
    const questionParts = messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.type === 'tool_call' && p.toolCallId === 'question-1');
    expect(questionParts).toHaveLength(2);
    expect(questionParts[0]).toMatchObject({ status: 'complete', answers: { '0': 'Vitest' } });
    expect(questionParts[1]).toMatchObject({ status: 'pending' });
  });

  it('never drops a duplicate from a record the open turn cannot overlap', () => {
    // The second guard, independent of the first: an EMPTY finished-looking call
    // is still a real record of an earlier turn once a person has spoken after
    // it. Only the trailing assistant run can overlap the turn still streaming.
    const olderHistory: HistoryMessage[] = [
      { id: 'h1', role: 'user', content: 'first', timestamp: '2026-01-01T00:00:00Z' },
      {
        id: 'h2',
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T00:00:01Z',
        parts: [
          {
            type: 'tool_call',
            toolCallId: '0',
            toolName: 'Read',
            input: '{}',
            status: 'complete',
          },
        ],
      },
      { id: 'h3', role: 'user', content: 'second', timestamp: '2026-01-01T00:00:02Z' },
    ];
    const messages = projectSessionMessages(olderHistory, [
      { seq: 1, type: 'turn_start' },
      { seq: 2, type: 'tool_call', toolCallId: '0', toolName: 'Edit', status: 'running' },
    ]);
    const toolParts = messages.flatMap((m) => m.parts ?? []).filter((p) => p.type === 'tool_call');
    expect(toolParts).toHaveLength(2);
    expect(toolParts[0]).toMatchObject({ toolName: 'Read' });
  });
});

describe('projectInProgressTurn — approval receipts', () => {
  /** The ask, as the durable stream carries it. */
  function ask(id: string): SessionEvent {
    return {
      seq: 1,
      type: 'approval_required',
      id,
      toolName: 'Bash',
      input: '{"command":"npm test"}',
      startedAt: 1_000,
      remainingMs: 600_000,
      hasSuggestions: false,
    };
  }

  /** The tool-call part the fold produced, with its approval fields visible. */
  function approvalPart(events: SessionEvent[]) {
    return projectInProgressTurn(events)[0] as {
      approvalOutcome?: string;
      approvalResolvedAt?: number;
      status: string;
    };
  }

  it('records an approval as allowed, with when it was answered', () => {
    // Purpose: the answer has to survive on the part, not in a component — this
    // is the whole basis for a receipt that outlives the card.
    const part = approvalPart([
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('allowed');
    expect(part.approvalResolvedAt).toBe(5_000);
  });

  it('records the answer on the LIVE path, where the turn never saw the ask', () => {
    // Purpose: the shape production actually produces. A live client's store
    // routes `approval_required` to `pendingInteractions`, NOT into the turn,
    // and the resolution retires that DTO — so when the answer arrives the turn
    // holds a BARE tool_call with nothing marking it as gated. Every test that
    // seeds `approval_required` into the turn is testing the cold-snapshot
    // shape and would pass while live sessions showed no receipt at all.
    const part = approvalPart([
      { seq: 1, type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', status: 'pending' },
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
        startedAt: 1_000,
      },
    ]) as unknown as { interactiveType?: string; approvalStartedAt?: number } & {
      approvalOutcome?: string;
    };
    expect(part.interactiveType).toBe('approval');
    expect(part.approvalOutcome).toBe('allowed');
    // The server's backfill is the only source for this on the live path.
    expect(part.approvalStartedAt).toBe(1_000);
  });

  it('records that a reason reached the agent, on the LIVE path', () => {
    // Purpose: the receipt's "agent was told why" clause is a claim about what
    // the agent received, so only the server can authorize it. Pinned on the
    // live shape (a bare tool_call the resolution lands on) because that is
    // what production produces — the ask itself never enters the turn.
    const part = projectInProgressTurn([
      { seq: 1, type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', status: 'pending' },
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'denied',
        at: 5_000,
        reasonGiven: true,
      },
    ])[0] as { approvalOutcome?: string; approvalReasonGiven?: boolean };
    expect(part.approvalOutcome).toBe('denied');
    expect(part.approvalReasonGiven).toBe(true);
  });

  it('claims nothing about a reason when a denial carried none', () => {
    const part = projectInProgressTurn([
      ask('tc-1'),
      { seq: 2, type: 'interaction_resolved', id: 'tc-1', kind: 'approval', resolution: 'denied' },
    ])[0] as { approvalReasonGiven?: boolean };
    expect(part.approvalReasonGiven).toBeUndefined();
  });

  it('does NOT mint a receipt for a timed-out question', () => {
    // Purpose: the collision that refutes "an expired resolution means an
    // approval". `handleAskUserQuestion`'s timeout calls the same
    // `notifyInteractionCancelled(..., 'timeout')` the approval path does, and
    // the normalizer maps that to `expired` for EVERY interaction kind — while
    // AskUserQuestion, being an ordinary tool_use block, has a real tool_call
    // part in the turn under the same id. Inferring the kind from the
    // resolution therefore printed "Expired — denied after 10:00" over a
    // question the person was merely asked and never answered.
    const part = approvalPart([
      {
        seq: 1,
        type: 'tool_call',
        toolCallId: 'q-1',
        toolName: 'AskUserQuestion',
        status: 'pending',
      },
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'q-1',
        kind: 'question',
        resolution: 'expired',
        at: 601_000,
        startedAt: 1_000,
      },
    ]) as unknown as { interactiveType?: string; approvalOutcome?: string };
    expect(part.approvalOutcome).toBeUndefined();
    expect(part.interactiveType).not.toBe('approval');
  });

  it('does NOT mint a receipt for a declined elicitation that shares a tool id', () => {
    // Purpose: an elicitation decline resolves `denied`, the same value a
    // refused permission carries. Only the kind separates them.
    const part = approvalPart([
      { seq: 1, type: 'tool_call', toolCallId: 'e-1', toolName: 'Bash', status: 'pending' },
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'e-1',
        kind: 'elicitation',
        resolution: 'denied',
        at: 5_000,
      },
    ]) as unknown as { approvalOutcome?: string };
    expect(part.approvalOutcome).toBeUndefined();
  });

  it('records a denial as denied', () => {
    const part = approvalPart([
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'denied',
        at: 5_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('denied');
    expect(part.status).toBe('error');
  });

  it('records a timed-out request as expired, distinct from a denial', () => {
    // Purpose: nobody answered an expired request. Folding it as `denied` would
    // put words in the operator's mouth.
    const part = approvalPart([
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'expired',
        at: 601_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('expired');
    expect(part.status).toBe('error');
  });

  it('leaves no outcome on a cancelled ask', () => {
    // Purpose: an SDK abort withdrew the question before anyone could answer —
    // there is no decision to record.
    const part = approvalPart([
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'cancelled',
      },
    ]);
    expect(part.approvalOutcome).toBeUndefined();
    expect(part.status).toBe('error');
  });

  it('keeps the outcome when the tool result races ahead of the resolution', () => {
    // Purpose: ordering between the runtime's tool_result and the projector's
    // resolution is not guaranteed. The receipt must not depend on winning it.
    const part = approvalPart([
      ask('tc-1'),
      { seq: 2, type: 'tool_result', toolCallId: 'tc-1', toolName: 'Bash', status: 'complete' },
      {
        seq: 3,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('allowed');
    expect(part.status).toBe('complete');
  });

  it('leaves an answered question alone', () => {
    // Purpose: `answered` belongs to AskUserQuestion, which keeps its own
    // summary — an approval receipt would be the wrong shape for it.
    const parts = projectInProgressTurn([
      {
        seq: 1,
        type: 'question_prompt',
        id: 'q-1',
        startedAt: 1_000,
        remainingMs: 600_000,
        questions: [
          { header: 'Color', question: 'Which?', options: [{ label: 'Blue' }], multiSelect: false },
        ],
      },
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'q-1',
        kind: 'question',
        resolution: 'answered',
        at: 5_000,
      },
    ]);
    expect((parts[0] as { approvalOutcome?: string }).approvalOutcome).toBeUndefined();
  });

  it('is stable across a replay that crosses the wire', () => {
    // Purpose: a reconnect replays from Last-Event-ID, and those events arrive
    // as JSON off an SSE stream — not as the objects this process happens to
    // hold. Round-tripping through serialization is what makes this a replay
    // test rather than an identity check on one array.
    const events: SessionEvent[] = [
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
      },
    ];
    const replayed = JSON.parse(JSON.stringify(events)) as SessionEvent[];
    expect(replayed).not.toBe(events);
    expect(projectInProgressTurn(replayed)).toEqual(projectInProgressTurn(events));
    expect(
      (projectInProgressTurn(replayed)[0] as { approvalOutcome?: string }).approvalOutcome
    ).toBe('allowed');
  });

  // DOR-939: an agent's held destructive capability call surfaces inline as the
  // same approval card the dashboard shows, and retires when the hold resolves.
  const HELD_APPROVAL = {
    approvalId: 'appr-1',
    capabilityId: 'mcp.add',
    capabilityTitle: 'Add an MCP server',
    tier: 'destructive' as const,
    summary: 'Prober wants to run "Add an MCP server"',
    hasAgentPath: true,
    requestedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T02:00:00.000Z',
  };

  it('projects a capability_approval_required event to an inline approval card', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'Adding the server…' },
      {
        seq: 2,
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: 1_000_000,
        capMs: 45_000,
      },
    ];
    const parts = projectInProgressTurn(events);
    // The inline card carries the SAME PendingApproval the dashboard renders, so
    // approving it resolves the same approvalId through the capability route.
    expect(parts).toEqual([
      { type: 'text', text: 'Adding the server…' },
      { type: 'capability_approval', approval: HELD_APPROVAL },
    ]);
  });

  it('retires the inline capability card on its capability_approval_resolved event', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: 1_000_000,
        capMs: 45_000,
      },
      { seq: 2, type: 'capability_approval_resolved', approvalId: 'appr-1', outcome: 'granted' },
    ];
    // The hold ended, so the card disappears from the transcript — exactly as the
    // dashboard card retires on approval_resolved.
    expect(projectInProgressTurn(events).some((p) => p.type === 'capability_approval')).toBe(false);
  });

  // DOR-987: a TIMEOUT is the one ending where the request outlives the hold —
  // it is still sitting in Approvals. Retiring the card the same way as a real
  // decision deleted the only thing on screen pointing at it.
  it('keeps the capability card as a terminal note when the hold TIMED OUT', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: 1_000_000,
        capMs: 45_000,
      },
      { seq: 2, type: 'capability_approval_resolved', approvalId: 'appr-1', outcome: 'timeout' },
    ];
    expect(projectInProgressTurn(events)).toEqual([
      { type: 'capability_approval', approval: HELD_APPROVAL, outcome: 'timeout' },
    ]);
  });

  it('retires the capability card on an EXPIRED resolution — nobody can answer it now', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: 1_000_000,
        capMs: 45_000,
      },
      { seq: 2, type: 'capability_approval_resolved', approvalId: 'appr-1', outcome: 'expired' },
    ];
    expect(projectInProgressTurn(events).some((p) => p.type === 'capability_approval')).toBe(false);
  });
});

// DOR-1004: an OAuth sign-in an agent asked for surfaces as a card in the
// conversation, carrying the link and the custody disclosure so the agent never
// has to paste them into its reply.
describe('mcp sign-in card', () => {
  const CARD = {
    serverName: 'granola',
    agentId: '01HV7KJZZZ0000000000000000',
    flowId: 'flow-1',
    authorizeUrl: 'https://mcp.test.local/authorize',
    disclosure: 'DorkOS stores the token on this machine.',
  };

  /** The `mcp_signin_required` event for a flow, at a given seq. */
  function required(seq: number, over: Partial<typeof CARD> = {}): SessionEvent {
    return { seq, type: 'mcp_signin_required', ...CARD, ...over } as SessionEvent;
  }

  it('projects an mcp_signin_required event to an inline sign-in card', () => {
    const parts = projectInProgressTurn([
      { seq: 1, type: 'text_delta', text: 'Connecting your meeting notes.' },
      required(2),
    ]);
    expect(parts).toEqual([
      { type: 'text', text: 'Connecting your meeting notes.' },
      { type: 'mcp_signin', ...CARD },
    ]);
  });

  it('turns the card into a receipt when the sign-in connects', () => {
    // It used to retire the part here, reasoning that the agent was already
    // resuming. That deleted the payoff about a second after it appeared and left
    // the transcript with no record that anything had been authorized.
    const parts = projectInProgressTurn([
      required(1),
      { seq: 2, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected', toolCount: 7 },
    ]);
    expect(parts).toEqual([{ type: 'mcp_signin', ...CARD, outcome: 'connected', toolCount: 7 }]);
  });

  it('never invents a tool count the resolution did not carry', () => {
    const parts = projectInProgressTurn([
      required(1),
      { seq: 2, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected' },
    ]);
    expect(parts).toEqual([{ type: 'mcp_signin', ...CARD, outcome: 'connected' }]);
  });

  it('keeps the card as a terminal note when the sign-in FAILED', () => {
    // Removing it would leave a person who was sent to a browser with no sign
    // anything went wrong.
    expect(
      projectInProgressTurn([
        required(1),
        { seq: 2, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'failed' },
      ])
    ).toEqual([{ type: 'mcp_signin', ...CARD, outcome: 'failed' }]);
  });

  it('replaces a LIVE card when the same server is signed in to again', () => {
    // A retry mints a NEW flow; the old link is dead the moment it does, so
    // stacking a second live card would offer a choice between a working link and
    // a broken one.
    const parts = projectInProgressTurn([
      required(1),
      required(2, { flowId: 'flow-2', authorizeUrl: 'https://mcp.test.local/authorize?2' }),
    ]);
    expect(parts).toEqual([
      {
        type: 'mcp_signin',
        ...CARD,
        flowId: 'flow-2',
        authorizeUrl: 'https://mcp.test.local/authorize?2',
      },
    ]);
  });

  it('keeps a settled receipt beside the retry that follows it', () => {
    // The receipt is the record of an attempt that really happened; a retry does
    // not unmake it. Overwriting it was how the failure vanished from the
    // transcript the moment the agent tried again.
    const parts = projectInProgressTurn([
      required(1),
      { seq: 2, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'failed' },
      required(3, { flowId: 'flow-2', authorizeUrl: 'https://mcp.test.local/authorize?2' }),
    ]);
    expect(parts).toEqual([
      { type: 'mcp_signin', ...CARD, outcome: 'failed' },
      {
        type: 'mcp_signin',
        ...CARD,
        flowId: 'flow-2',
        authorizeUrl: 'https://mcp.test.local/authorize?2',
      },
    ]);
  });

  it('keeps a second server’s card beside the first', () => {
    const parts = projectInProgressTurn([required(1), required(2, { serverName: 'linear' })]);
    expect(parts.map((p) => (p.type === 'mcp_signin' ? p.serverName : p.type))).toEqual([
      'granola',
      'linear',
    ]);
  });

  it('ignores a resolution for a flow that was already replaced', () => {
    // The abandoned flow's late resolution must not settle the card that took its
    // place, which is why resolutions match on flow id and cards on server.
    const parts = projectInProgressTurn([
      required(1),
      required(2, { flowId: 'flow-2' }),
      { seq: 3, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected' },
    ]);
    expect(parts).toEqual([{ type: 'mcp_signin', ...CARD, flowId: 'flow-2' }]);
  });
});
