import { describe, it, expect } from 'vitest';
import { HistoryMessageSchema } from '@dorkos/shared/schemas';
import type { HistoryMessage, ToolCallPart } from '@dorkos/shared/types';
import { parseTranscript } from '../transcript-parser.js';

/**
 * An `AskUserQuestion` whose recorded input is not the shape the SDK types
 * promise (DOR-2075).
 *
 * The JSONL holds the model's raw tool input, and nothing checked it on the way
 * into history. A question without `multiSelect` reached the client, failed the
 * snapshot schema, and the client threw the whole snapshot away, so the session
 * never loaded.
 */

/** One assistant line asking the given questions. */
function askLines(questions: unknown): string[] {
  return [
    JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-09-15T10:00:00.000Z',
      message: { role: 'user', content: 'Help me pick a date library.' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-09-15T10:00:04.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_q_1', name: 'AskUserQuestion', input: { questions } },
        ],
      },
    }),
  ];
}

/** The `tool_call` part for the question, from anywhere in the parsed history. */
function questionPart(messages: HistoryMessage[]): ToolCallPart {
  for (const message of messages) {
    for (const p of message.parts ?? []) {
      if (p.type === 'tool_call' && p.toolCallId === 'toolu_q_1') return p;
    }
  }
  throw new Error('no question part in parsed history');
}

describe('parseTranscript — AskUserQuestion input', () => {
  it('reads a question that omits multiSelect as single-choice', () => {
    const messages = parseTranscript(
      askLines([
        {
          question: 'Which library should we use?',
          header: 'Library',
          options: [{ label: 'date-fns' }, { label: 'luxon' }],
        },
      ])
    );

    expect(questionPart(messages).questions?.[0]?.multiSelect).toBe(false);
    const toolCall = messages.flatMap((m) => m.toolCalls ?? [])[0];
    expect(toolCall?.questions?.[0]?.multiSelect).toBe(false);
    for (const message of messages) {
      expect(HistoryMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('keeps a question it cannot read as a question, without taking the history down', () => {
    // No question text and no options: there is nothing to render, but the
    // call is still a question, and every other message must still load.
    const messages = parseTranscript(askLines([{ header: 'Library' }]));

    const part = questionPart(messages);
    expect(part.interactiveType).toBe('question');
    expect(part.questions).toBeUndefined();
    for (const message of messages) {
      expect(HistoryMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});
