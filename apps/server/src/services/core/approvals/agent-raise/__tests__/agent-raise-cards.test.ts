/**
 * The agent-raise card store on its own (DOR-4355 M4). Security N2: the stored
 * write runs once, whatever the approval store does, because committing takes
 * the card out before it runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../approval-service.js';
import { eventFanOut } from '../../../event-fan-out.js';
import {
  commitAgentRaise,
  initAgentRaiseCards,
  raiseAgentCard,
  resetAgentRaiseCardsForTests,
} from '../agent-raise-cards.js';

const PORTER = {
  agentPath: '/made-up/agents/porter',
  displayName: 'Porter',
  createdAt: '2026-11-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initAgentRaiseCards(new ApprovalService(createTestDb()));
});
afterEach(() => {
  resetAgentRaiseCardsForTests();
  vi.restoreAllMocks();
});

describe('committing an agent-raise card', () => {
  it('runs the stored write once: a second commit of the same card is refused', async () => {
    const run = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const card = raiseAgentCard(
      { identity: PORTER, presentsAgent: true },
      {
        kind: 'relay.allowlist',
        target: 'sl',
        input: { op: 'save' },
        effect: { summary: 'Let U0NEWBIE1 approve your agents’ requests.', changes: [] },
        run,
      }
    );
    expect(card.status).toBe(428);
    const approvalId = card.body.approvalId as string;

    expect(await commitAgentRaise(approvalId, 'Dorian')).toEqual({
      status: 200,
      body: { ok: true },
    });
    const again = await commitAgentRaise(approvalId, 'Dorian');
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'agent_raise_gone' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
