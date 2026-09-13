import { describe, it, expect } from 'vitest';
import type { HistoryMessage, ToolCallPart } from '@dorkos/shared/types';
import { parseTranscript } from '../transcript-parser.js';

/**
 * A `tool_use` the transcript never pairs with a result (DOR-2011).
 *
 * This is the RELOAD half of the gated-tool bug. A page refreshed while a
 * permission prompt is open rebuilds its transcript from the JSONL, and at that
 * instant the write's `tool_use` block is on disk while its result — which only
 * exists once somebody approves — is not. The parser stamped such a call
 * `complete`, so the reloaded tab drew a green check on a tool nobody had
 * allowed yet: the same lie the live stream was telling, arriving by the other
 * road.
 *
 * The fixture is written inline rather than read from a file because the whole
 * point is what is ABSENT, and a missing line is easier to trust when you can
 * see the two that surround it.
 */

/** The two JSONL lines a turn has written by the time the prompt goes up. */
const MID_APPROVAL: string[] = [
  JSON.stringify({
    type: 'user',
    uuid: 'u-1',
    timestamp: '2026-09-12T21:58:00.000Z',
    message: { role: 'user', content: 'Create a file named hello.txt containing the word hello.' },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a-1',
    timestamp: '2026-09-12T21:58:04.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll create that file." },
        {
          type: 'tool_use',
          id: 'toolu_write_1',
          name: 'Write',
          input: { file_path: 'hello.txt', content: 'hello' },
        },
      ],
    },
  }),
  // No `tool_result` line: the operator has not answered the prompt yet.
];

/** The same turn, once the write was approved and reported back. */
const AFTER_APPROVAL: string[] = [
  ...MID_APPROVAL,
  JSON.stringify({
    type: 'user',
    uuid: 'u-2',
    timestamp: '2026-09-12T21:58:40.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_write_1',
          content: [{ type: 'text', text: 'File created successfully at: hello.txt' }],
        },
      ],
    },
  }),
];

/** The `tool_call` part for an id, from anywhere in the parsed history. */
function part(messages: HistoryMessage[], toolCallId: string): ToolCallPart {
  for (const message of messages) {
    const found = message.parts?.find((p) => p.type === 'tool_call' && p.toolCallId === toolCallId);
    if (found?.type === 'tool_call') return found;
  }
  throw new Error(`no tool_call part for ${toolCallId}`);
}

/** The legacy `toolCalls` twin of {@link part}, which history also carries. */
function call(messages: HistoryMessage[], toolCallId: string) {
  for (const message of messages) {
    const found = message.toolCalls?.find((tc) => tc.toolCallId === toolCallId);
    if (found) return found;
  }
  throw new Error(`no toolCall for ${toolCallId}`);
}

describe('a tool_use with no result yet', () => {
  it('rebuilds a mid-approval write as still running, not as done', () => {
    const messages = parseTranscript(MID_APPROVAL);

    expect(part(messages, 'toolu_write_1').status).toBe('running');
    expect(part(messages, 'toolu_write_1').result).toBeUndefined();
    // Both halves of history, which `applyToolResult` overwrites together.
    expect(call(messages, 'toolu_write_1').status).toBe('running');
  });

  it('never reports it pending, which would claim the session is waiting on you', () => {
    // `use-chat-session` scans the whole transcript for a tool call that is
    // `pending` WITH an `interactiveType` and reads it as an unanswered prompt.
    // An ordinary unpaired tool call must not be able to reach that scan, or a
    // turn that died would leave a closed session asking for an answer forever.
    const tool = part(parseTranscript(MID_APPROVAL), 'toolu_write_1');

    expect(tool.status).not.toBe('pending');
    expect(tool.interactiveType).toBeUndefined();
  });

  it('settles to complete with its result once the pairing arrives', () => {
    // The placeholder is only ever a placeholder: the discriminating partner,
    // proving the status above is what an UNPAIRED call gets rather than what
    // every call now gets.
    const messages = parseTranscript(AFTER_APPROVAL);

    expect(part(messages, 'toolu_write_1').status).toBe('complete');
    expect(part(messages, 'toolu_write_1').result).toContain('File created successfully');
    expect(call(messages, 'toolu_write_1').status).toBe('complete');
  });
});
