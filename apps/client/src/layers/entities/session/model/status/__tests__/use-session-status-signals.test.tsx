/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockSessionLimit } from '@dorkos/test-utils';
import { renderHook } from '@testing-library/react';
import type { SessionStatus, SessionLifecycle } from '@dorkos/shared/session-stream';
import { useSessionChatStore, type SessionState } from '../../stream/session-chat-store';
import { useSessionStreamStore } from '../../stream/session-stream-store';
import { useSessionListStore } from '../../stream/session-list-store';
import { useSessionStatusSignals } from '../use-session-status-signals';

const SESSION_ID = 's1';

function setSession(patch: Partial<SessionState>) {
  useSessionChatStore.getState().updateSession(SESSION_ID, patch);
}

function statusWithLifecycle(lifecycle: SessionLifecycle): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle,
    lastError: null,
    limit: null,
    accountUsage: null,
  };
}

/** Hydrate a stream-store entry for SESSION_ID with the given lifecycle. */
function hydrateStreamSession(lifecycle: SessionLifecycle, pendingCount = 0) {
  useSessionStreamStore.getState().applySnapshot(SESSION_ID, {
    messages: [],
    inProgressTurn: null,
    status: statusWithLifecycle(lifecycle),
    pendingInteractions: Array.from({ length: pendingCount }, (_, i) => ({
      id: `int-${i}`,
      type: 'approval' as const,
      startedAt: 1000,
      remainingMs: 30000,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    })),
    queuedMessages: [],
    canvas: [],
    cursor: 1,
  });
}

describe('useSessionStatusSignals', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
  });

  const read = (limitStatus?: Pick<SessionStatus, 'lifecycle' | 'limit'> | null) =>
    renderHook(() => useSessionStatusSignals(SESSION_ID, limitStatus)).result.current;

  it('says nothing for a session with no store entry', () => {
    expect(read()).toEqual({
      needsYou: false,
      working: false,
      limited: null,
      failed: false,
      unseen: false,
    });
  });

  it('reads working from the chat store status or a running SDK', () => {
    setSession({ status: 'streaming' });
    expect(read().working).toBe(true);
    setSession({ status: 'idle', sdkState: 'running' });
    expect(read().working).toBe(true);
  });

  it('reads a failed last turn', () => {
    setSession({ status: 'error' });
    expect(read().failed).toBe(true);
  });

  it('reads unseen background activity from the list store', () => {
    useSessionListStore.getState().markUnseen(SESSION_ID);
    expect(read().unseen).toBe(true);
  });

  it('reads needs-you from sdkState=requires_action', () => {
    setSession({ sdkState: 'requires_action' });
    expect(read().needsYou).toBe(true);
  });

  it('reads needs-you from an interactive tool call', () => {
    setSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          parts: [],
          timestamp: new Date().toISOString(),
          toolCalls: [
            {
              toolCallId: 'tc1',
              toolName: 'Bash',
              input: 'ls',
              status: 'pending',
              interactiveType: 'approval',
            },
          ],
        },
      ],
    });
    expect(read().needsYou).toBe(true);
  });

  it('reports every true fact at once, unranked', () => {
    setSession({ status: 'error' });
    useSessionListStore.getState().markUnseen(SESSION_ID);
    const limit = createMockSessionLimit('ask');
    expect(read({ lifecycle: 'idle', limit })).toMatchObject({
      failed: true,
      unseen: true,
      limited: { needsAction: true },
    });
  });

  // Merged live sources (spec chat-stream-reconnection). Regression context:
  // the reads used to come ONLY from the legacy chat store, which no live path
  // writes anymore — so "Working" never appeared (user report 2026-06-11).
  describe('stream-store and list-store sources', () => {
    it('reads working from the per-session stream store with no chat-store entry', () => {
      hydrateStreamSession('streaming');
      expect(read().working).toBe(true);
    });

    it('reads needs-you when the stream store holds pending interactions', () => {
      hydrateStreamSession('blocked', 1);
      expect(read().needsYou).toBe(true);
    });

    it('reads working from a session_status fan-out for a never-hydrated session', () => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        cwd: '/work/alpha',
        status: statusWithLifecycle('streaming'),
      });
      expect(read().working).toBe(true);
    });

    it('maps a blocked list-store lifecycle to needs-you', () => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        status: statusWithLifecycle('blocked'),
      });
      expect(read().needsYou).toBe(true);
    });

    it('maps an error lifecycle to failed', () => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        status: statusWithLifecycle('error'),
      });
      expect(read().failed).toBe(true);
    });

    it('treats interrupted as idle — no false activity signal', () => {
      hydrateStreamSession('interrupted');
      expect(read()).toMatchObject({ working: false, needsYou: false, failed: false });
    });

    it('settles back to idle when a session_removed clears the status', () => {
      const store = useSessionListStore.getState();
      store.applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        status: statusWithLifecycle('streaming'),
      });
      store.applyListEvent({ type: 'session_removed', sessionId: SESSION_ID });
      expect(read().working).toBe(false);
    });
  });

  describe('out of usage (spec claude-account-ui §6.2)', () => {
    it('reads a limited session as needing action while it asks', () => {
      const limit = createMockSessionLimit('ask');
      expect(read({ lifecycle: 'idle', limit }).limited).toMatchObject({ needsAction: true });
    });

    it('reads a waiting session as no longer needing action (Q13)', () => {
      const limit = createMockSessionLimit('waiting');
      expect(read({ lifecycle: 'idle', limit }).limited).toMatchObject({ needsAction: false });
    });

    it('never reads a moved session as limited (Q14)', () => {
      const limit = createMockSessionLimit('continued');
      expect(read({ lifecycle: 'idle', limit }).limited).toBeNull();
    });

    it('never reads a model-scope limit as limited, in any state', () => {
      for (const limit of [
        createMockSessionLimit('ask', { scope: 'model', state: 'model-limited' }),
        createMockSessionLimit('waiting', { scope: 'model' }),
      ]) {
        expect(read({ lifecycle: 'idle', limit }).limited).toBeNull();
      }
    });

    it('reads no limit when the caller passes no status', () => {
      expect(read(null).limited).toBeNull();
    });
  });
});
