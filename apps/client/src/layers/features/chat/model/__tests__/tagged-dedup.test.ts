import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HistoryMessage, MessagePart } from '@dorkos/shared/types';
import type { ChatMessage } from '../chat-types';
import { reconcileTaggedMessages } from '../stream-history-helpers';

// ---------------------------------------------------------------------------
// Helper to apply setMessages calls against a mutable state array
// ---------------------------------------------------------------------------
function applySetMessages(
  state: ChatMessage[],
  calls: Array<(prev: ChatMessage[]) => ChatMessage[]>
): ChatMessage[] {
  return calls.reduce((acc, fn) => fn(acc), state);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tagged-dedup in seed effect Branch 2', () => {
  let setMessagesCalls: Array<(prev: ChatMessage[]) => ChatMessage[]>;
  let setMessages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setMessagesCalls = [];
    setMessages = vi.fn((fn: (prev: ChatMessage[]) => ChatMessage[]) => {
      setMessagesCalls.push(fn);
    });
  });

  it('matches tagged user message by exact content and replaces with server version', () => {
    const clientId = 'pending-user-abc';
    const current: ChatMessage[] = [
      {
        id: clientId,
        role: 'user',
        content: 'Hello',
        parts: [{ type: 'text', text: 'Hello' }],
        timestamp: '',
        _streaming: true,
      },
    ];
    const history: HistoryMessage[] = [{ id: 'server-user-1', role: 'user', content: 'Hello' }];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('server-user-1');
    expect(result[0]._streaming).toBe(false);
  });

  it('matches tagged assistant by position immediately after matched user', () => {
    const clientUserId = 'pending-user-abc';
    const clientAsstId = 'pending-asst-xyz';
    const current: ChatMessage[] = [
      {
        id: clientUserId,
        role: 'user',
        content: 'Hello',
        parts: [{ type: 'text', text: 'Hello' }],
        timestamp: '',
        _streaming: true,
      },
      {
        id: clientAsstId,
        role: 'assistant',
        content: 'Hi there',
        parts: [{ type: 'text', text: 'Hi there' }],
        timestamp: '',
        _streaming: true,
      },
    ];
    const history: HistoryMessage[] = [
      { id: 'server-user-1', role: 'user', content: 'Hello' },
      { id: 'server-asst-1', role: 'assistant', content: 'Hi there' },
    ];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('server-user-1');
    expect(result[0]._streaming).toBe(false);
    expect(result[1].id).toBe('server-asst-1');
    expect(result[1]._streaming).toBe(false);
  });

  it('carries over client-only subagent parts on assistant match', () => {
    const clientUserId = 'pending-user-abc';
    const clientAsstId = 'pending-asst-xyz';
    const subagentPart: MessagePart = {
      type: 'subagent',
      taskId: 'task-1',
      description: 'Running tests',
      status: 'complete',
    };
    const current: ChatMessage[] = [
      {
        id: clientUserId,
        role: 'user',
        content: 'Run tests',
        parts: [{ type: 'text', text: 'Run tests' }],
        timestamp: '',
        _streaming: true,
      },
      {
        id: clientAsstId,
        role: 'assistant',
        content: 'Done',
        parts: [{ type: 'text', text: 'Done' }, subagentPart],
        timestamp: '',
        _streaming: true,
      },
    ];
    const history: HistoryMessage[] = [
      { id: 'server-user-1', role: 'user', content: 'Run tests' },
      { id: 'server-asst-1', role: 'assistant', content: 'Done' },
    ];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    expect(result).toHaveLength(2);
    const asst = result[1];
    expect(asst.id).toBe('server-asst-1');
    // Server has text part, client subagent part is carried over
    const subagentInResult = asst.parts.find((p) => p.type === 'subagent');
    expect(subagentInResult).toBeDefined();
    expect(subagentInResult).toMatchObject({ type: 'subagent', taskId: 'task-1' });
  });

  it('does not duplicate subagent parts when server already includes them', () => {
    const clientUserId = 'pending-user-abc';
    const clientAsstId = 'pending-asst-xyz';
    const subagentPart: MessagePart = {
      type: 'subagent',
      taskId: 'task-1',
      description: 'Running tests',
      status: 'complete',
    };
    const current: ChatMessage[] = [
      {
        id: clientUserId,
        role: 'user',
        content: 'Run tests',
        parts: [{ type: 'text', text: 'Run tests' }],
        timestamp: '',
        _streaming: true,
      },
      {
        id: clientAsstId,
        role: 'assistant',
        content: 'Done',
        parts: [{ type: 'text', text: 'Done' }, subagentPart],
        timestamp: '',
        _streaming: true,
      },
    ];
    // Server response includes the same subagent part (transcript parser extracted it)
    const history: HistoryMessage[] = [
      { id: 'server-user-1', role: 'user', content: 'Run tests' },
      {
        id: 'server-asst-1',
        role: 'assistant',
        content: 'Done',
        parts: [
          { type: 'text', text: 'Done' },
          { type: 'subagent', taskId: 'task-1', description: 'Running tests', status: 'complete' },
        ],
      },
    ];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    const asst = result[1];
    // Should have exactly one subagent part, not two
    const subagentParts = asst.parts.filter((p) => p.type === 'subagent');
    expect(subagentParts).toHaveLength(1);
    expect(subagentParts[0]).toMatchObject({ taskId: 'task-1' });
  });

  it('does not match when user content differs', () => {
    const clientId = 'pending-user-abc';
    const current: ChatMessage[] = [
      {
        id: clientId,
        role: 'user',
        content: 'Hello',
        parts: [{ type: 'text', text: 'Hello' }],
        timestamp: '',
        _streaming: true,
      },
    ];
    const history: HistoryMessage[] = [
      { id: 'server-user-1', role: 'user', content: 'Different message' },
    ];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    // No match: server message appended, original client message stays
    expect(result).toHaveLength(2);
    expect(result.find((m) => m.id === clientId)).toBeDefined();
    expect(result.find((m) => m.id === 'server-user-1')).toBeDefined();
  });

  it('appends unmatched server messages normally when no tagged messages exist', () => {
    const current: ChatMessage[] = [
      {
        id: 'existing-1',
        role: 'user',
        content: 'Existing',
        parts: [{ type: 'text', text: 'Existing' }],
        timestamp: '',
      },
    ];
    const history: HistoryMessage[] = [
      { id: 'existing-1', role: 'user', content: 'Existing' },
      { id: 'new-server-1', role: 'assistant', content: 'New response' },
    ];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe('new-server-1');
  });

  it('clears _streaming flag to false on match', () => {
    const clientId = 'pending-user-abc';
    const current: ChatMessage[] = [
      {
        id: clientId,
        role: 'user',
        content: 'Hello',
        parts: [{ type: 'text', text: 'Hello' }],
        timestamp: '',
        _streaming: true,
      },
    ];
    const history: HistoryMessage[] = [{ id: 'server-user-1', role: 'user', content: 'Hello' }];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    expect(result[0]._streaming).toBe(false);
  });

  it('does not match assistant when user was not matched first', () => {
    const clientAsstId = 'pending-asst-xyz';
    const current: ChatMessage[] = [
      {
        id: clientAsstId,
        role: 'assistant',
        content: 'Hi there',
        parts: [{ type: 'text', text: 'Hi there' }],
        timestamp: '',
        _streaming: true,
      },
    ];
    // Server has a user + assistant pair, but no tagged user to match
    const history: HistoryMessage[] = [
      { id: 'server-user-1', role: 'user', content: 'Hello' },
      { id: 'server-asst-1', role: 'assistant', content: 'Hi there' },
    ];

    reconcileTaggedMessages(current, history, setMessages);

    const result = applySetMessages(current, setMessagesCalls);
    // Both server messages appended; original tagged assistant stays
    expect(result).toHaveLength(3);
    expect(result.find((m) => m.id === clientAsstId)?._streaming).toBe(true);
  });
});
