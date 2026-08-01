import { describe, it, expect } from 'vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { groupApprovalReceipts } from '../group-approval-receipts';

const ANSWERED_AT = 1_700_000_000_000;

/** An answered approval part, as the projection folds one. */
function answered(
  toolCallId: string,
  approvalOutcome: 'allowed' | 'denied' | 'expired',
  approvalResolvedAt: number | undefined = ANSWERED_AT
): MessagePart {
  return {
    type: 'tool_call',
    toolCallId,
    toolName: 'Bash',
    input: '{}',
    status: 'complete',
    interactiveType: 'approval',
    approvalOutcome,
    approvalResolvedAt,
  };
}

const text: MessagePart = { type: 'text', text: 'between' };

describe('groupApprovalReceipts', () => {
  it('gives a lone answered approval its own receipt', () => {
    const groups = groupApprovalReceipts([answered('tc-1', 'allowed')]);
    expect(groups.get(0)).toEqual({ leadIndex: 0, indices: [0], outcome: 'allowed' });
  });

  it('collapses adjacent requests answered the same way at the same moment', () => {
    // Purpose: "Approve all" resolves each request separately, so the stream
    // carries no batch identity — adjacency plus a shared answer at a shared
    // instant is what makes one line honest.
    const groups = groupApprovalReceipts([
      answered('tc-1', 'allowed'),
      answered('tc-2', 'allowed', ANSWERED_AT + 40),
      answered('tc-3', 'allowed', ANSWERED_AT + 90),
    ]);
    expect(groups.get(0)).toMatchObject({ leadIndex: 0, indices: [0, 1, 2] });
    expect(groups.get(2)?.leadIndex).toBe(0);
  });

  it('keeps decisions minutes apart as separate receipts', () => {
    // Purpose: two answers a person gave at different times are two decisions.
    const groups = groupApprovalReceipts([
      answered('tc-1', 'allowed'),
      answered('tc-2', 'allowed', ANSWERED_AT + 120_000),
    ]);
    expect(groups.get(0)?.leadIndex).toBe(0);
    expect(groups.get(1)?.leadIndex).toBe(1);
  });

  it('never merges an allow with a deny', () => {
    const groups = groupApprovalReceipts([answered('tc-1', 'allowed'), answered('tc-2', 'denied')]);
    expect(groups.get(0)?.leadIndex).toBe(0);
    expect(groups.get(1)?.leadIndex).toBe(1);
  });

  it('breaks a run when anything else sits between the two answers', () => {
    // Purpose: the receipt sits at the interaction's own place in the
    // transcript. Merging across intervening content would move it.
    const groups = groupApprovalReceipts([
      answered('tc-1', 'allowed'),
      text,
      answered('tc-2', 'allowed'),
    ]);
    expect(groups.get(0)?.leadIndex).toBe(0);
    expect(groups.has(1)).toBe(false);
    expect(groups.get(2)?.leadIndex).toBe(2);
  });

  it('ignores approvals still waiting for an answer', () => {
    const pending: MessagePart = {
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'Bash',
      input: '{}',
      status: 'pending',
      interactiveType: 'approval',
    };
    expect(groupApprovalReceipts([pending]).size).toBe(0);
  });

  it('ignores plain tool calls that were never gated', () => {
    const plain: MessagePart = {
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'Read',
      input: '{}',
      status: 'complete',
    };
    expect(groupApprovalReceipts([plain]).size).toBe(0);
  });
});
