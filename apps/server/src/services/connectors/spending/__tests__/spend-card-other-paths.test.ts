/**
 * A paid-run card answers only through the person's Allow once in DorkOS
 * (DOR-4204 PR 2, Security Must 2). These pin the other ways a yes can reach
 * an agent's action, and show none of them reaches a spend card.
 */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService, hashApprovalInput } from '../../../core/approvals/index.js';
import { relayApprovableCard } from '../../../core/session-relay/relay-approvable.js';
import { AccessApprovalService } from '../../access/access-approval.js';

function spendCard(approvals: ApprovalService) {
  return approvals.request({
    capabilityId: 'connectors.execute_read',
    inputHash: hashApprovalInput({ query: 'Northwind pricing' }),
    summary: 'Acme Search: Search the web for "Northwind pricing".',
    requestedBy: 'kestrel',
    serviceAction: {
      serviceId: 'tavily',
      serviceName: 'Acme Search',
      accountLabel: 'Work',
      actionName: 'Search the web',
      details: [],
      keptCardBecause: 'spend',
      spend: {
        priceMicro: null,
        priceSource: null,
        limitMicro: null,
        leftMicro: null,
        currency: 'USD',
      },
    },
  });
}

describe('the other ways a yes can arrive', () => {
  it('a Telegram or Slack button answers a runtime tool card, never a DorkOS paid-run card', () => {
    for (const toolName of [
      'mcp__dorkos__connectors_execute_read',
      'mcp__dorkos__connectors_execute_write',
      'connectors.execute_read',
    ]) {
      expect(
        relayApprovableCard({ toolName, input: '{}' }, { cwd: '/agents/kestrel' } as never)
      ).toBe(false);
    }
  });

  it("another agent's approve_request answers an access request by its own id, never a card", async () => {
    const approvals = new ApprovalService(createTestDb());
    const card = spendCard(approvals);
    const access = new AccessApprovalService({
      db: createTestDb(),
      requests: { pending: () => undefined },
    } as never);
    await expect(
      access.approve(
        {
          agentId: 'agent-other',
          owner: { kind: 'local_install', installationId: 'install-a' },
        } as never,
        { requestId: card.approvalId }
      )
    ).rejects.toMatchObject({ code: 'APPROVE_NOT_FOUND' });
    expect(approvals.answerScope(card.approvalId)?.state).toBe('pending');
  });

  it('a saved Always allow never covers it: Always is not offered on a paid-run card', () => {
    const approvals = new ApprovalService(createTestDb());
    const card = spendCard(approvals);
    expect(approvals.answerScope(card.approvalId)).toMatchObject({
      alwaysOffered: false,
      spend: true,
    });
  });
});
