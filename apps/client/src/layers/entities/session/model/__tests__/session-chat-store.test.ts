import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionChatStore, DEFAULT_SESSION_STATE } from '../session-chat-store';

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
    expect(session.hasUnseenActivity).toBe(false);
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

  it('renames session atomically preserving all state', () => {
    const { initSession, updateSession, renameSession, getSession } =
      useSessionChatStore.getState();
    initSession('old-id');
    updateSession('old-id', { input: 'my draft', status: 'streaming' });
    renameSession('old-id', 'new-id');
    expect(getSession('new-id').input).toBe('my draft');
    expect(getSession('new-id').status).toBe('streaming');
    expect(getSession('old-id')).toEqual(DEFAULT_SESSION_STATE);
  });

  it('renameSession updates sessionAccessOrder', () => {
    const { initSession, renameSession } = useSessionChatStore.getState();
    initSession('s1');
    initSession('s2');
    renameSession('s1', 's1-new');
    const { sessionAccessOrder } = useSessionChatStore.getState();
    expect(sessionAccessOrder).toContain('s1-new');
    expect(sessionAccessOrder).not.toContain('s1');
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

  it('renameSession is a no-op for unknown oldId', () => {
    const { renameSession, getSession } = useSessionChatStore.getState();
    renameSession('nonexistent', 'new-id');
    expect(getSession('new-id')).toEqual(DEFAULT_SESSION_STATE);
  });
});
