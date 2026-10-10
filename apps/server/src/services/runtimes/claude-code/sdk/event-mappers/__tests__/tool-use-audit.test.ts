/**
 * Claude Code tool calls reach the audit log (spec `audit-trail` PR3): a Bash
 * call streamed by the real stream mapper (input in pieces, then a
 * `tool_call_end` that only means the input finished), settled by the real
 * message mapper's tool_result, becomes exactly one `runtime.tool_used` row
 * with the full command as its target.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { mapStreamEvent } from '../stream-event-mapper.js';
import { mapMessageEvent } from '../message-event-mapper.js';
import { createToolState, type AgentSession } from '../../../agent-types.js';
import { resetAuditTrail } from '../../../../../audit/audit-trail.js';
import {
  runTurn,
  setUpAuditTrail,
  toolRows,
} from '../../../../../audit/__tests__/tool-use-harness.js';

const streamEvent = (event: Record<string, unknown>) =>
  ({ type: 'stream_event', event }) as unknown as SDKMessage;

async function collect(source: AsyncGenerator<StreamEvent>, into: StreamEvent[]) {
  for await (const event of source) into.push(event);
}

describe('Claude Code tool calls in the audit log', () => {
  afterEach(() => resetAuditTrail());

  it('records a streamed Bash call once, when its result arrives', async () => {
    const db = setUpAuditTrail();
    const toolState = createToolState();
    const session = { sdkSessionId: null, hasStarted: true } as unknown as AgentSession;
    const events: StreamEvent[] = [];

    for (const message of [
      streamEvent({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' },
      }),
      streamEvent({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"command":"git ' },
      }),
      streamEvent({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: 'status"}' },
      }),
      streamEvent({ type: 'content_block_stop' }),
    ]) {
      await collect(mapStreamEvent(message, 'session-1', toolState), events);
    }
    await collect(
      mapMessageEvent(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [{ type: 'text', text: 'clean' }],
              },
            ],
          },
        } as unknown as SDKMessage,
        session,
        toolState,
        'session-1'
      ),
      events
    );

    await runTurn(events, { runtime: 'claude-code' });

    expect(toolRows(db)).toMatchObject([
      {
        targetType: 'command',
        targetId: 'git status',
        outcome: 'ok',
        source: { runtime: 'claude-code', toolCallId: 'toolu_1' },
      },
    ]);
  });
});
