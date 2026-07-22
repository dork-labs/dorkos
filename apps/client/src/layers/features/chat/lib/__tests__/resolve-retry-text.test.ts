import { describe, it, expect } from 'vitest';
import type { AgentBirthRecord, ChatMessage } from '@/layers/shared/model';
import { resolveTransportRetryText } from '../resolve-retry-text';

function userMsg(content: string): ChatMessage {
  return {
    id: 'u1',
    role: 'user',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: '',
  };
}

const FIRST_MESSAGE_RECORD: AgentBirthRecord = {
  kind: 'first-message',
  name: 'dorkbot',
  displayName: 'DorkBot',
  agentId: 'dorkbot',
  bornAt: '',
  path: '/agents/dorkbot',
  runtime: 'claude-code',
  kickoffMessage: 'help me set up a project',
  fired: true,
};

describe('resolveTransportRetryText', () => {
  it('resends the last user message when one exists', () => {
    expect(resolveTransportRetryText([userMsg('hello there')], null)).toBe('hello there');
  });

  it('falls back to a first-message birth record when the transcript has no user message', () => {
    // The dissolve case: the optimistic bubble was dropped on the failed trigger,
    // so the only copy of the text is the birth record.
    expect(resolveTransportRetryText([], FIRST_MESSAGE_RECORD)).toBe('help me set up a project');
  });

  it('prefers a real user message over the birth record', () => {
    expect(resolveTransportRetryText([userMsg('typed again')], FIRST_MESSAGE_RECORD)).toBe(
      'typed again'
    );
  });

  it('does not fall back for an ordinary kickoff record', () => {
    const kickoff: AgentBirthRecord = { ...FIRST_MESSAGE_RECORD, kind: 'kickoff' };
    expect(resolveTransportRetryText([], kickoff)).toBeUndefined();
  });

  it('returns undefined when there is nothing to resend', () => {
    expect(resolveTransportRetryText([], null)).toBeUndefined();
  });
});
