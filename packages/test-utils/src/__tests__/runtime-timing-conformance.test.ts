import { it, expect } from 'vitest';
import { assertRuntimeTimingEvents } from '../runtime-timing-conformance.js';
it('rejects terminal timestamps on a tool whose arguments merely finished', () => {
  expect(() =>
    assertRuntimeTimingEvents([
      {
        type: 'tool_call_end',
        data: { toolCallId: 'a', toolName: 'Read', status: 'running', endedAt: 1 },
      },
    ])
  ).toThrow();
});
it('rejects malformed model readings and preserves honest absence', () => {
  expect(() =>
    assertRuntimeTimingEvents([
      { type: 'model_request', data: { phase: 'usage', outputTokens: -1 } } as never,
    ])
  ).toThrow();
  assertRuntimeTimingEvents([{ type: 'model_request', data: { phase: 'usage' } }]);
});
