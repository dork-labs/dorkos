import { expect, it } from 'vitest';
import { resolveApprovalDecision } from '../approvals.js';

it.each([
  ['bypassPermissions', 'auto-approve', 'auto-approve'],
  ['acceptEdits', 'auto-approve', 'ask'],
  ['default', 'ask', 'ask'],
  ['dontAsk', 'ask', 'ask'],
  ['future-mode', 'ask', 'ask'],
  [undefined, 'ask', 'ask'],
] as const)('decides eligible ordinary requests under %s', (mode, edit, other) => {
  expect(resolveApprovalDecision(mode, 'edit')).toBe(edit);
  expect(resolveApprovalDecision(mode, 'other')).toBe(other);
});
