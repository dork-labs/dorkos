import { describe, it, expect, beforeEach } from 'vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { useSessionChatStore, DEFAULT_SESSION_STATE } from '../session-chat-store';

/** A pending Approve/Deny tool_call part — the card DOR-73 drops on session switch. */
const PENDING_APPROVAL_PART: MessagePart = {
  type: 'tool_call',
  toolCallId: 'tool-approval-1',
  toolName: 'Bash',
  input: 'mkdir foo',
  status: 'pending',
  interactiveType: 'approval',
};

describe('useSessionChatStore', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });

  it('initializes session with default state', () => {
    const { initSession, getSession } = useSessionChatStore.getState();
    initSession('s1');
    const session = getSession('s1');
    expect(session.status).toBe('idle');
    expect(session.messages).toEqual([]);
    expect(session.input).toBe('');
  });

  it('does not overwrite existing session on re-init', () => {
    const { initSession, updateSession, getSession } = useSessionChatStore.getState();
    initSession('s1');
    updateSession('s1', { input: 'draft text' });
    initSession('s1');
    expect(getSession('s1').input).toBe('draft text');
  });

  it('updates session fields via updateSession', () => {
    const { initSession, updateSession, getSession } = useSessionChatStore.getState();
    initSession('s1');
    updateSession('s1', { status: 'streaming', input: 'hello' });
    const session = getSession('s1');
    expect(session.status).toBe('streaming');
    expect(session.input).toBe('hello');
  });

  it('auto-initializes session on updateSession if not present', () => {
    const { updateSession, getSession } = useSessionChatStore.getState();
    updateSession('new-session', { input: 'test' });
    expect(getSession('new-session').input).toBe('test');
    expect(getSession('new-session').status).toBe('idle');
  });

  it('evicts oldest idle sessions beyond MAX_RETAINED_SESSIONS', () => {
    const { initSession } = useSessionChatStore.getState();
    for (let i = 0; i < 21; i++) {
      initSession(`s${i}`);
    }
    const { sessions, sessionAccessOrder } = useSessionChatStore.getState();
    expect(sessionAccessOrder.length).toBeLessThanOrEqual(20);
    expect(sessions['s0']).toBeUndefined();
  });

  it('never evicts sessions with status === streaming', () => {
    const { initSession, updateSession } = useSessionChatStore.getState();
    for (let i = 0; i < 20; i++) {
      initSession(`s${i}`);
    }
    // Mark the oldest as streaming
    updateSession('s0', { status: 'streaming' });
    // Add one more to trigger eviction
    initSession('s20');
    const { sessions } = useSessionChatStore.getState();
    expect(sessions['s0']).toBeDefined();
    expect(sessions['s0'].status).toBe('streaming');
  });

  it('never evicts a session holding an unsent composer draft (DOR-480)', () => {
    // The most literal instance of the whole class: type something, don't send
    // it, visit 21 other conversations, and your words were deleted. The draft
    // is the one thing in this entry the server cannot hand back.
    const { initSession, updateSession, getSession } = useSessionChatStore.getState();
    initSession('s0');
    updateSession('s0', { input: 'half a thought I want to keep' });
    for (let i = 1; i < 21; i++) {
      initSession(`s${i}`);
    }

    expect(useSessionChatStore.getState().sessions['s0']).toBeDefined();
    expect(getSession('s0').input).toBe('half a thought I want to keep');
  });

  it('evicts once the draft is gone — the guard protects words, not entries', () => {
    const { initSession, updateSession } = useSessionChatStore.getState();
    initSession('s0');
    updateSession('s0', { input: 'draft' });
    for (let i = 1; i < 21; i++) {
      initSession(`s${i}`);
    }
    expect(useSessionChatStore.getState().sessions['s0']).toBeDefined();

    // Sending clears the composer; s0 is now ordinary. Walk past the cap again,
    // since the write above moved it to the front of the LRU.
    updateSession('s0', { input: '   ' }); // whitespace is not a draft
    for (let i = 21; i < 43; i++) {
      initSession(`s${i}`);
    }

    expect(useSessionChatStore.getState().sessions['s0']).toBeUndefined();
  });

  it('tracks access order for LRU eviction', () => {
    const { initSession, touchSession } = useSessionChatStore.getState();
    initSession('s1');
    initSession('s2');
    initSession('s3');
    touchSession('s1');
    const { sessionAccessOrder } = useSessionChatStore.getState();
    expect(sessionAccessOrder[0]).toBe('s1');
  });

  it('destroySession removes session and access order entry', () => {
    const { initSession, destroySession, getSession } = useSessionChatStore.getState();
    initSession('s1');
    destroySession('s1');
    expect(getSession('s1')).toEqual(DEFAULT_SESSION_STATE);
    const { sessionAccessOrder } = useSessionChatStore.getState();
    expect(sessionAccessOrder).not.toContain('s1');
  });

  it('getSession returns default state for unknown sessionId', () => {
    const { getSession } = useSessionChatStore.getState();
    expect(getSession('nonexistent')).toEqual(DEFAULT_SESSION_STATE);
  });

  it('initSession drops a pending interaction part, and a recovery hydrate re-adds it (DOR-73)', () => {
    // Purpose: the literal switch/refresh drop-and-restore. A blocked session holds a
    // pending Approve/Deny part in `currentParts`. On session switch/refresh the
    // ChatPanel remounts and `initSession()` resets that session's `currentParts` to []
    // (the drop point at session-chat-store ~193-197), orphaning the card. Recovery
    // (the `/events` snapshot hydrate) then feeds the interaction back through the store
    // — the same `updateSession` write the renderer's `setMessages`/currentParts flush
    // performs — and the pending part must RE-POPULATE and persist.
    const { initSession, updateSession, getSession } = useSessionChatStore.getState();

    // Live blocked turn: the pending card sits in currentParts.
    initSession('s-blocked');
    updateSession('s-blocked', { currentParts: [PENDING_APPROVAL_PART], status: 'streaming' });
    expect(getSession('s-blocked').currentParts).toHaveLength(1);

    // DOR-73 drop: a fresh init for the SAME id (e.g. a remount that destroyed then
    // re-created the entry, as happens on switch/refresh) clears currentParts to [].
    useSessionChatStore.getState().destroySession('s-blocked');
    initSession('s-blocked');
    expect(getSession('s-blocked').currentParts).toEqual([]);

    // Recovery hydrate: a renderer re-adds the pending part via the store.
    updateSession('s-blocked', { currentParts: [PENDING_APPROVAL_PART] });

    const restored = getSession('s-blocked').currentParts;
    expect(restored).toHaveLength(1);
    const part = restored[0];
    expect(part.type === 'tool_call' && part.interactiveType).toBe('approval');
    expect(part.type === 'tool_call' && part.status).toBe('pending');
    expect(part.type === 'tool_call' && part.toolCallId).toBe('tool-approval-1');
  });
});
