import { it, expect } from 'vitest';
import { parseTranscript } from '../sessions/transcript-parser.js';
it('fills tools from their own JSONL message timestamps, leaving missing or invalid times absent', () => {
  const lines = [
    {
      type: 'assistant',
      uuid: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] },
    },
    {
      type: 'assistant',
      uuid: 'b',
      timestamp: 'invalid',
      message: { content: [{ type: 'tool_use', id: 'y', name: 'Read', input: {} }] },
    },
    {
      type: 'user',
      uuid: 'c',
      timestamp: '2026-01-01T00:00:01Z',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'y', content: 'ok' },
        ],
      },
    },
  ].map((record) => JSON.stringify(record));
  const history = parseTranscript(lines);
  const tools = history.flatMap((m) => m.parts ?? []).filter((p) => p.type === 'tool_call');
  expect(tools[0]).toMatchObject({ startedAt: 1767225600000, endedAt: 1767225601000 });
  expect(tools[1]).not.toHaveProperty('startedAt');
  expect(tools[1]).toHaveProperty('endedAt', 1767225601000);
});
