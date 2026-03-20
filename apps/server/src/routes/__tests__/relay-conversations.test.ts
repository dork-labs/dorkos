import { describe, it, expect } from 'vitest';
import { buildConversations } from '../relay.js';
import type { SubjectLabel } from '../../services/relay/subject-resolver.js';

// === Helpers ===

function makeMsg(
  overrides?: Partial<{ id: string; subject: string; status: string; createdAt: string }>
) {
  return {
    id: 'msg-001',
    subject: 'relay.agent.session-abc',
    status: 'delivered',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeadLetter(
  messageId: string,
  reason = 'TTL expired',
  from = 'relay.human.console.user1'
) {
  return {
    messageId,
    reason,
    envelope: {
      id: messageId,
      subject: 'relay.agent.session-abc',
      from,
      replyTo: undefined,
      budget: { hopCount: 1, maxHops: 5, ancestorChain: [], ttl: 0, callBudgetRemaining: 10 },
      createdAt: '2024-01-01T00:00:00.000Z',
      payload: { text: 'original question text' },
    },
    deadLetteredAt: '2024-01-01T00:01:00.000Z',
  };
}

function makeLabel(label: string, raw: string): SubjectLabel {
  return { label, raw };
}

// === Tests ===

describe('buildConversations', () => {
  it('returns empty array for empty input', () => {
    const result = buildConversations([], [], new Map());
    expect(result).toEqual([]);
  });

  it('request without matching dead letter has status pending', () => {
    const msg = makeMsg({ status: 'pending' });
    const result = buildConversations([msg], [], new Map());
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('pending');
    expect(result[0].failureReason).toBeUndefined();
  });

  it('request matched to dead letter has failureReason populated', () => {
    const msg = makeMsg();
    const dl = makeDeadLetter('msg-001', 'hop limit exceeded');
    const result = buildConversations([msg], [dl], new Map());
    expect(result).toHaveLength(1);
    expect(result[0].failureReason).toBe('hop limit exceeded');
  });

  it('dead letter envelope from field resolves via labelMap', () => {
    const msg = makeMsg();
    const dl = makeDeadLetter('msg-001', 'expired', 'relay.human.console.user1');
    const labelMap = new Map<string, SubjectLabel>([
      ['relay.human.console.user1', makeLabel('You', 'relay.human.console.user1')],
      ['relay.agent.session-abc', makeLabel('LifeOS Agent', 'relay.agent.session-abc')],
    ]);
    const result = buildConversations([msg], [dl], labelMap);
    expect(result[0].from).toMatchObject({ label: 'You', raw: 'relay.human.console.user1' });
    expect(result[0].to).toMatchObject({ label: 'LifeOS Agent', raw: 'relay.agent.session-abc' });
  });

  it('counts response chunks correctly', () => {
    const fromSubject = 'relay.human.console.user1';
    const request = makeMsg({
      id: 'req-1',
      subject: 'relay.agent.session-abc',
      status: 'delivered',
    });
    const chunk1 = makeMsg({
      id: 'chunk-1',
      subject: fromSubject,
      createdAt: '2024-01-01T00:00:01.000Z',
    });
    const chunk2 = makeMsg({
      id: 'chunk-2',
      subject: fromSubject,
      createdAt: '2024-01-01T00:00:02.000Z',
    });
    const dl = makeDeadLetter('req-1', 'expired', fromSubject);

    const result = buildConversations([request, chunk1, chunk2], [dl], new Map());
    expect(result[0].responseCount).toBe(2);
  });

  it('extracts sessionId from relay.agent.* subject', () => {
    const msg = makeMsg({ subject: 'relay.agent.abc-123-session-id' });
    const result = buildConversations([msg], [], new Map());
    expect(result[0].sessionId).toBe('abc-123-session-id');
  });

  it('sessionId is undefined for relay.system.* subject', () => {
    const msg = makeMsg({ subject: 'relay.system.pulse.sched-1' });
    const result = buildConversations([msg], [], new Map());
    expect(result[0].sessionId).toBeUndefined();
  });

  it('delivered request maps to delivered status', () => {
    const msg = makeMsg({ status: 'delivered' });
    const result = buildConversations([msg], [], new Map());
    expect(result[0].status).toBe('delivered');
  });

  it('failed request maps to failed status', () => {
    const msg = makeMsg({ status: 'failed' });
    const result = buildConversations([msg], [], new Map());
    expect(result[0].status).toBe('failed');
  });
});
