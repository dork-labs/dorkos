/**
 * Mocks for the approvals slice of the Transport:
 * nothing is waiting, every answer succeeds, and a full list reads empty.
 *
 * @module test-utils/mock-approvals
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The approval methods of the Transport. */
type ApprovalMethods =
  | 'listDeclinedHookApprovals'
  | 'askAgainHookApproval'
  | 'listPendingApprovals'
  | 'getApprovalFullDetail'
  | 'grantApproval'
  | 'denyApproval'
  | 'dismissAlwaysSuggestion';

/** Mock approval methods, each a `vi.fn()`. */
export function createMockApprovalTransport(): Pick<Transport, ApprovalMethods> {
  return {
    listDeclinedHookApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
    askAgainHookApproval: vi
      .fn()
      .mockImplementation((approvalId: string) => Promise.resolve({ ok: true, approvalId })),
    listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
    getApprovalFullDetail: vi.fn().mockResolvedValue({ text: '' }),
    grantApproval: vi
      .fn()
      .mockImplementation((approvalId: string) =>
        Promise.resolve({ ok: true, approvalId, outcome: 'granted' })
      ),
    denyApproval: vi
      .fn()
      .mockImplementation((approvalId: string) =>
        Promise.resolve({ ok: true, approvalId, outcome: 'denied' })
      ),
    dismissAlwaysSuggestion: vi
      .fn()
      .mockImplementation((approvalId: string) => Promise.resolve({ ok: true, approvalId })),
  };
}
