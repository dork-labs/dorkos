/**
 * The windows layer and the empty-stream guard must agree on what counts as
 * content (DOR-2064).
 *
 * `SessionTurnWindows` decides from the RAW frame whether an empty turn keeps
 * waiting; `empty-stream-guard.ts` decides from the MAPPED events whether the
 * turn gets "the agent did not respond". When the two disagree, a window closes
 * at once on a turn the guard still calls empty, or holds open a turn the guard
 * already accepted. Every row pushes one raw frame through the production
 * mapper and asserts the two answers match, so neither side can drift alone.
 *
 * Rows whose mapping depends on stream state carry the frames that set that
 * state up, exactly as a live turn would send them. The raw predicate cannot see
 * that state; the one shape where it would matter (a text delta inside an open
 * tool-use block) does not occur, because the API streams tool input as
 * `input_json_delta`.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-windows-content-parity
 */
import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { createToolState } from '../../agent-types.js';
import type { AgentSession } from '../../agent-types.js';
import { isContentEvent } from '../../messaging/empty-stream-guard.js';
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import { carriesVisibleContent } from '../session-turn-windows.js';

const SESSION_ID = 'parity-session';

/** A raw frame, cast once so each row reads as the wire shape it models. */
function frame(shape: Record<string, unknown>): SDKMessage {
  return shape as unknown as SDKMessage;
}

/** A `stream_event` wrapping `event`, optionally forwarded from a subagent. */
function streamEvent(event: Record<string, unknown>, parentToolUseId?: string): SDKMessage {
  return frame({
    type: 'stream_event',
    event,
    parent_tool_use_id: parentToolUseId ?? null,
    session_id: 'sdk-1',
    uuid: 'stream-1',
  });
}

const thinkingStart = streamEvent({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'thinking', thinking: '' },
});

interface Row {
  name: string;
  /** Frames sent first, so the mapper's stream state is what a live turn has. */
  setup?: SDKMessage[];
  frame: SDKMessage;
}

const ROWS: Row[] = [
  {
    name: 'a text delta',
    frame: streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
  },
  {
    name: 'a thinking delta inside a thinking block',
    setup: [thinkingStart],
    frame: streamEvent({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'hmm' },
    }),
  },
  { name: 'a bare message_start', frame: streamEvent({ type: 'message_start', message: {} }) },
  { name: 'a ping', frame: streamEvent({ type: 'ping' }) },
  { name: 'a content_block_stop', frame: streamEvent({ type: 'content_block_stop', index: 0 }) },
  { name: 'a thinking block starting', frame: thinkingStart },
  {
    name: 'a tool_use block starting',
    frame: streamEvent({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    }),
  },
  {
    name: 'a server_tool_use block starting',
    frame: streamEvent({
      type: 'content_block_start',
      content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
    }),
  },
  {
    name: "a subagent's forwarded text delta",
    frame: streamEvent(
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
      'toolu_task'
    ),
  },
  {
    name: 'a main-thread assistant message with text and thinking',
    frame: frame({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hello' },
        ],
      },
    }),
  },
  {
    name: "a subagent's forwarded assistant text",
    frame: frame({
      type: 'assistant',
      parent_tool_use_id: 'toolu_task',
      message: { content: [{ type: 'text', text: 'from the helper' }] },
    }),
  },
  {
    name: 'a main-thread tool result',
    frame: frame({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    }),
  },
  {
    name: "a subagent's tool result",
    frame: frame({
      type: 'user',
      parent_tool_use_id: 'toolu_task',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
    }),
  },
  {
    name: 'a replayed tool result',
    frame: frame({
      type: 'user',
      isReplay: true,
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'ok' }] },
    }),
  },
  {
    name: 'a user message whose content is a bare string',
    frame: frame({ type: 'user', parent_tool_use_id: null, message: { content: '/compact' } }),
  },
  {
    name: 'a tool use summary',
    frame: frame({
      type: 'tool_use_summary',
      summary: 'Read a file',
      preceding_tool_use_ids: ['t'],
    }),
  },
  {
    name: 'a tool use summary naming no calls',
    frame: frame({ type: 'tool_use_summary', summary: 'nothing', preceding_tool_use_ids: [] }),
  },
  {
    name: 'a manual compaction boundary',
    frame: frame({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 10, post_tokens: 2 },
    }),
  },
  {
    name: 'an automatic compaction boundary',
    frame: frame({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 10, post_tokens: 2 },
    }),
  },
  {
    name: 'an api retry notice',
    frame: frame({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 500,
      error_status: 529,
    }),
  },
];

/** Every event the production mapper yields for `rows`, in order. */
async function mapAll(messages: SDKMessage[]): Promise<StreamEvent[][]> {
  const session = { pendingInteractions: new Map(), eventQueue: [] } as unknown as AgentSession;
  const toolState = createToolState();
  const out: StreamEvent[][] = [];
  for (const message of messages) {
    const events: StreamEvent[] = [];
    for await (const event of mapSdkMessage(message, session, SESSION_ID, toolState)) {
      events.push(event);
    }
    out.push(events);
  }
  return out;
}

describe('carriesVisibleContent agrees with the empty-stream guard', () => {
  it.each(ROWS)('$name', async (row) => {
    const mapped = await mapAll([...(row.setup ?? []), row.frame]);
    const guardCounts = mapped.at(-1)!.some(isContentEvent);
    expect(carriesVisibleContent(row.frame)).toBe(guardCounts);
  });

  it('covers both answers, so agreement is not trivially all-false or all-true', async () => {
    const answers = await Promise.all(
      ROWS.map(async (row) =>
        (await mapAll([...(row.setup ?? []), row.frame])).at(-1)!.some(isContentEvent)
      )
    );
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });
});
