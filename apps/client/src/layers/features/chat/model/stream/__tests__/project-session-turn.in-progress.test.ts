// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { projectInProgressTurn } from '../project-session-turn';

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

  it('folds an image_attachment into an image part, as a reference', () => {
    // The whole reason the seam exists: an image the turn produced must reach
    // the bubble, and must reach it as a URL. Inlined bytes would be replayed
    // on every reconnect through buffers that count events rather than bytes.
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'Here you go.' },
      {
        seq: 2,
        type: 'image_attachment',
        attachmentId: 'abc123',
        url: '/api/sessions/s1/attachments/abc123.png',
        mediaType: 'image/png',
        size: 2048,
        alt: 'banana.png',
      },
    ];

    const parts = projectInProgressTurn(events);

    expect(parts).toEqual([
      { type: 'text', text: 'Here you go.' },
      {
        type: 'image',
        attachmentId: 'abc123',
        url: '/api/sessions/s1/attachments/abc123.png',
        mediaType: 'image/png',
        size: 2048,
        alt: 'banana.png',
      },
    ]);
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

  it('carries who asked for a compaction onto the row (DOR-2732)', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'compact_boundary',
        trigger: 'manual',
        preTokens: 178000,
        requestedBy: 'agent',
        contextPercent: 89,
      },
    ];
    expect(projectInProgressTurn(events)[0]).toEqual({
      type: 'compact_boundary',
      trigger: 'manual',
      preTokens: 178000,
      requestedBy: 'agent',
      contextPercent: 89,
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

  it('folds a permission_denied into an attributed denial chip part (DOR-795)', () => {
    // Purpose: a BACKGROUNDED subagent's tool call is auto-denied by the CLI and
    // the refusal is written into the CHILD's transcript, which nobody opens. If
    // this fold drops `agentId`, the chip can report that something was blocked
    // but not WHICH helper lost WHAT — the whole content of the warning.
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'Delegating that.' },
      {
        seq: 2,
        type: 'permission_denied',
        toolCallId: 'toolu_async_1',
        toolName: 'Bash',
        message: 'Backgrounded agents cannot request permission.',
        reasonType: 'asyncAgent',
        agentId: 'agent_child_7',
      },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts.map((p) => p.type)).toEqual(['text', 'permission_denied']);
    expect(parts[1]).toEqual({
      type: 'permission_denied',
      toolCallId: 'toolu_async_1',
      toolName: 'Bash',
      message: 'Backgrounded agents cannot request permission.',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
    });
  });

  it('folds a model_substituted into a lasting notice part naming both models (DOR-2636)', () => {
    const events: SessionEvent[] = [
      {
        type: 'model_substituted',
        seq: 2,
        from: 'opus',
        fromName: 'Opus',
        to: 'md_suggested',
        toName: 'Suggested',
        reason: 'credits-not-covered',
      },
      { seq: 3, type: 'text_delta', text: 'On it.' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts.map((p) => p.type)).toEqual(['model_substituted', 'text']);
    expect(parts[0]).toEqual({
      type: 'model_substituted',
      from: 'opus',
      fromName: 'Opus',
      to: 'md_suggested',
      toName: 'Suggested',
      reason: 'credits-not-covered',
    });
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
