import { expect, it } from 'vitest';
import { projectBrowserActionReceipt } from '../action-receipt.js';
const binding = {
  browserId: 'browser_original_0000000000',
  browserGeneration: 1,
  tabId: 'tab_original_0000000000000',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 1,
  inputGeneration: 1,
};
it('projects a completed original action without the private envelope', () => {
  expect(
    projectBrowserActionReceipt({
      kind: 'action',
      requestId: 'request_original_000000000',
      binding,
      outcome: 'completed',
    })
  ).toEqual({
    requestId: 'request_original_000000000',
    binding,
    outcome: 'completed',
  });
});
it.each(['rejected', 'aborted', 'uncertain'] as const)(
  'keeps %s outcomes and closed original failure metadata',
  (outcome) => {
    expect(
      projectBrowserActionReceipt({
        kind: 'action',
        requestId: 'request_original_000000000',
        binding,
        outcome,
        reason: 'dispatchFailed',
      })
    ).toEqual({
      requestId: 'request_original_000000000',
      binding,
      outcome,
      reason: { version: 1, reason: 'dispatchFailed' },
    });
  }
);
it.each([
  null,
  { kind: 'opened' },
  {
    kind: 'action',
    requestId: 'request_original_000000000',
    binding,
    outcome: 'uncertain',
    reason: 'private process/path',
  },
  {
    kind: 'action',
    requestId: 'request_original_000000000',
    binding,
    outcome: 'completed',
    unexpected: 'private data',
  },
])('refuses malformed or private result metadata', (value) => {
  expect(() => projectBrowserActionReceipt(value)).toThrow();
});
