import { mapSdkMessage } from '../sdk/sdk-event-mapper.js';
import { createToolState, type AgentSession } from '../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRequestEvents } from '../sdk/request-timing.js';
const stream = (event: object, parent_tool_use_id: string | null = null) =>
  ({ type: 'stream_event', event, parent_tool_use_id }) as SDKMessage;
afterEach(() => vi.restoreAllMocks());
describe('Claude request timing', () => {
  it('correlates response phases and per-message usage without inventing dispatch time', () => {
    const owner = {};
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const start = claudeRequestEvents(
      stream({
        type: 'message_start',
        message: {
          id: 'req',
          model: 'example',
          usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
        },
      }),
      owner
    );
    expect(start[0].data).toEqual({
      requestId: 'req',
      model: 'example',
      inputTokens: 10,
      phase: 'start',
    });
    expect(
      claudeRequestEvents(stream({ type: 'content_block_delta', delta: { text: '' } }), owner)
    ).toEqual([]);
    expect(
      claudeRequestEvents(stream({ type: 'content_block_delta', delta: { text: 'x' } }), owner)[0]
        .data
    ).toMatchObject({ firstTokenAt: 100, phase: 'first_token' });
    claudeRequestEvents(stream({ type: 'message_delta', usage: { output_tokens: 7 } }), owner);
    vi.spyOn(Date, 'now').mockReturnValue(200);
    const end = claudeRequestEvents(stream({ type: 'message_stop' }), owner)[0];
    expect(end.data).toEqual({
      requestId: 'req',
      model: 'example',
      inputTokens: 10,
      outputTokens: 7,
      firstTokenAt: 100,
      endedAt: 200,
      phase: 'end',
    });
    expect(claudeRequestEvents(stream({ type: 'message_stop' }), owner)).toEqual([]);
  });
  it('drops forwarded subagent responses and keeps owners separate', () => {
    const start = stream({ type: 'message_start', message: { id: 'child' } }, 'parent');
    expect(claudeRequestEvents(start, {})).toEqual([]);
    expect(claudeRequestEvents(stream({ type: 'message_stop' }), {})).toEqual([]);
  });
});

it('wires model events through the SDK dispatcher without timing argument completion as execution end', async () => {
  const state = createToolState();
  const session = { sdkSessionId: 's', hasStarted: true } as AgentSession;
  const messages = [
    stream({ type: 'message_start', message: { id: 'req' } }),
    stream({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'a', name: 'Read' },
    }),
    stream({ type: 'content_block_stop' }),
  ];
  const events: StreamEvent[] = [];
  for (const message of messages)
    for await (const event of mapSdkMessage(message, session, 's', state)) events.push(event);
  expect(events.find((e) => e.type === 'model_request')?.data).toMatchObject({
    requestId: 'req',
    phase: 'start',
  });
  expect(events.find((e) => e.type === 'tool_call_start')?.data).toHaveProperty('startedAt');
  expect(events.find((e) => e.type === 'tool_call_end')?.data).not.toHaveProperty('endedAt');
});
