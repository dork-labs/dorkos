import { describe, it, expect } from 'vitest';
import { mapSdkMessage } from '../sdk-event-mapper.js';
import type { AgentSession, ToolState } from '../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';

/** Collect all events yielded by the mapper for a single message. */
async function collectEvents(
  ...args: Parameters<typeof mapSdkMessage>
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of mapSdkMessage(...args)) {
    events.push(event);
  }
  return events;
}

function makeSession(): AgentSession {
  return {
    sdkSessionId: null,
    hasStarted: false,
  } as AgentSession;
}

function makeToolState(): ToolState {
  let inThinking = false;
  let thinkingStartMs = 0;
  return {
    inTool: false,
    currentToolName: '',
    currentToolId: '',
    taskToolInput: '',
    toolNameById: new Map(),
    get inThinking() { return inThinking; },
    set inThinking(v: boolean) { inThinking = v; },
    get thinkingStartMs() { return thinkingStartMs; },
    set thinkingStartMs(v: number) { thinkingStartMs = v; },
    setToolState(inTool: boolean, name: string, id: string) {
      this.inTool = inTool;
      this.currentToolName = name;
      this.currentToolId = id;
    },
    resetTaskInput() {
      this.taskToolInput = '';
    },
    appendTaskInput(chunk: string) {
      this.taskToolInput += chunk;
    },
  } as ToolState;
}

function makeStreamEvent(event: Record<string, unknown>): Parameters<typeof mapSdkMessage>[0] {
  return {
    type: 'stream_event',
    event,
  } as unknown as Parameters<typeof mapSdkMessage>[0];
}

describe('sdk-event-mapper thinking blocks', () => {
  const session = makeSession();
  const sessionId = 'test-session';

  it('content_block_start(thinking) sets inThinking flag', async () => {
    // Purpose: Verify thinking block start is detected and toolState flags are set.
    const toolState = makeToolState();
    const msg = makeStreamEvent({
      type: 'content_block_start',
      content_block: { type: 'thinking' },
    });

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0); // No event emitted for start
    expect(toolState.inThinking).toBe(true);
    expect(toolState.thinkingStartMs).toBeGreaterThan(0);
  });

  it('content_block_delta(thinking_delta) yields thinking_delta event', async () => {
    // Purpose: Verify thinking deltas are mapped to thinking_delta StreamEvents
    // when the toolState is in thinking mode.
    const toolState = makeToolState();
    toolState.inThinking = true;

    const msg = makeStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'Let me consider...' },
    });

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('thinking_delta');
    expect(events[0].data).toEqual({ text: 'Let me consider...' });
  });

  it('ignores thinking_delta when not in thinking mode', async () => {
    // Purpose: Guard against spurious thinking_delta events when inThinking is false.
    const toolState = makeToolState();
    toolState.inThinking = false;

    const msg = makeStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'stray delta' },
    });

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('content_block_stop resets inThinking flag', async () => {
    // Purpose: Verify thinking block end resets the flag without emitting tool_call_end.
    const toolState = makeToolState();
    toolState.inThinking = true;

    const msg = makeStreamEvent({ type: 'content_block_stop' });
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0); // No event emitted for thinking stop
    expect(toolState.inThinking).toBe(false);
  });

  it('full thinking-to-text transition emits correct event sequence', async () => {
    // Purpose: End-to-end sequence: thinking start → thinking deltas → thinking stop → text delta.
    // Verifies the complete lifecycle produces the right events in order.
    const toolState = makeToolState();

    const blockStart = makeStreamEvent({
      type: 'content_block_start',
      content_block: { type: 'thinking' },
    });
    const delta1 = makeStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'First ' },
    });
    const delta2 = makeStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'thought' },
    });
    const blockStop = makeStreamEvent({ type: 'content_block_stop' });
    const textDelta = makeStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello!' },
    });

    const allEvents: StreamEvent[] = [];
    for (const msg of [blockStart, delta1, delta2, blockStop, textDelta]) {
      const events = await collectEvents(msg, session, sessionId, toolState);
      allEvents.push(...events);
    }

    expect(allEvents).toHaveLength(3); // 2 thinking_delta + 1 text_delta
    expect(allEvents[0]).toEqual({ type: 'thinking_delta', data: { text: 'First ' } });
    expect(allEvents[1]).toEqual({ type: 'thinking_delta', data: { text: 'thought' } });
    expect(allEvents[2]).toEqual({ type: 'text_delta', data: { text: 'Hello!' } });
    expect(toolState.inThinking).toBe(false);
  });

  it('does not interfere with normal text_delta when not thinking', async () => {
    // Purpose: Regression — ensure existing text_delta behavior is unaffected by thinking support.
    const toolState = makeToolState();

    const msg = makeStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Normal text' },
    });

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('text_delta');
    expect(events[0].data).toEqual({ text: 'Normal text' });
  });
});
