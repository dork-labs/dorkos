/**
 * What a dead-lettered message tells the notification pipeline about its
 * sender (DOR-1408).
 *
 * @module services/notifications/__tests__/dead-letter-payload
 */
import { describe, it, expect } from 'vitest';
import type { DeadLetterNotice } from '@dorkos/relay';
import { deadLetterAgentId, deadLetterPayload } from '../emitters/dead-letter.js';

/** A dead-letter arrival notice, exactly as `DeadLetterQueue.reject` raises one. */
function notice(overrides: Partial<DeadLetterNotice> = {}): DeadLetterNotice {
  return {
    messageId: 'dl-1',
    endpointHash: 'endpoint-abc',
    reason: 'budget exceeded',
    failedAt: '2026-08-21T00:00:00.000Z',
    fromSubject: 'relay.agent.myproject.agent-42',
    ...overrides,
  };
}

describe('the payload a dead letter sends', () => {
  it('stamps the mesh agent that sent it', () => {
    const payload = deadLetterPayload(notice({ fromSubject: 'relay.agent.myproject.agent-42' }));

    expect(payload.agentId).toBe('agent-42');
    expect(payload.deadLetterId).toBe('dl-1');
    expect(payload.reason).toBe('budget exceeded');
  });

  it('leaves agentId unstamped for a runtime-scoped session subject — a live session, not a mesh agent', () => {
    const payload = deadLetterPayload(notice({ fromSubject: 'relay.agent.claude-code.sess-1' }));

    expect(payload.agentId).toBeUndefined();
  });

  it('leaves agentId unstamped for a non-agent sender (the scheduler)', () => {
    const payload = deadLetterPayload(notice({ fromSubject: 'relay.system.tasks.notifier' }));

    expect(payload.agentId).toBeUndefined();
  });

  it('leaves agentId unstamped for a legacy two-segment subject', () => {
    const payload = deadLetterPayload(notice({ fromSubject: 'relay.agent.sess-legacy' }));

    expect(payload.agentId).toBeUndefined();
  });
});

describe('deadLetterAgentId', () => {
  it('extracts the trailing id only from an agent-scoped subject, never a session id or a non-agent sender', () => {
    expect(deadLetterAgentId('relay.agent.ns.agent-1')).toBe('agent-1');
    expect(deadLetterAgentId('relay.agent.claude-code.sess-1')).toBeUndefined();
    expect(deadLetterAgentId('relay.human.telegram.12345')).toBeUndefined();
  });
});
