/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionStatus, SessionLifecycle } from '@dorkos/shared/session-stream';
import { useSessionChatStore, type SessionState } from '../session-chat-store';
import { useSessionStreamStore } from '../session-stream-store';
import { useSessionListStore } from '../session-list-store';
import { useSessionBorderState } from '../use-session-border-state';

// Override the test-setup mock so we can toggle reduced motion per test.
const reducedMotionRef = { value: false };
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.value,
  };
});

const SESSION_ID = 's1';

function setSession(patch: Partial<SessionState>) {
  useSessionChatStore.getState().updateSession(SESSION_ID, patch);
}

function statusWithLifecycle(lifecycle: SessionLifecycle): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle,
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
    cursor: 1,
  });
}

describe('useSessionBorderState', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
    reducedMotionRef.value = false;
  });

  it('returns idle kind for a session with no store entry', () => {
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('idle');
    expect(result.current.pulse).toBe(false);
    expect(result.current.color).toBe('rgba(128, 128, 128, 0.08)');
  });

  it('returns streaming kind when status is streaming', () => {
    setSession({ status: 'streaming' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('streaming');
    expect(result.current.pulse).toBe(true);
    expect(result.current.dimColor).toBeDefined();
  });

  it('returns streaming kind when sdkState is running', () => {
    setSession({ sdkState: 'running' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('streaming');
  });

  it('returns error kind when status is error', () => {
    setSession({ status: 'error' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('error');
    expect(result.current.pulse).toBe(false);
  });

  it('returns unseen kind when the list store flags unseen background activity', () => {
    useSessionListStore.getState().markUnseen(SESSION_ID);
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('unseen');
  });

  it('detects pending approval from sdkState=requires_action', () => {
    setSession({ sdkState: 'requires_action' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('pendingApproval');
    expect(result.current.pulse).toBe(true);
  });

  it('detects pending approval from an interactive tool call', () => {
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
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('pendingApproval');
  });

  // Priority matrix
  it('pending approval beats streaming', () => {
    setSession({ status: 'streaming', sdkState: 'requires_action' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('pendingApproval');
  });

  it('streaming beats error', () => {
    setSession({ status: 'streaming' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('streaming');
  });

  it('error beats unseen activity', () => {
    setSession({ status: 'error' });
    useSessionListStore.getState().markUnseen(SESSION_ID);
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('error');
  });

  // Reduced motion
  it('suppresses pulse when prefers-reduced-motion is set', () => {
    reducedMotionRef.value = true;
    setSession({ status: 'streaming' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('streaming');
    expect(result.current.pulse).toBe(false);
  });

  it('suppresses pulse for pending approval when reduced motion is set', () => {
    reducedMotionRef.value = true;
    setSession({ sdkState: 'requires_action' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(result.current.kind).toBe('pendingApproval');
    expect(result.current.pulse).toBe(false);
  });

  // Labels
  it('provides human-readable labels for every kind', () => {
    const { result: idle } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(idle.current.label).toBe('Idle');

    setSession({ status: 'streaming' });
    const { result: streaming } = renderHook(() => useSessionBorderState(SESSION_ID));
    expect(streaming.current.label).toBe('Working');
  });

  // Merged live sources (spec chat-stream-reconnection). Regression context:
  // the hook used to read ONLY the legacy chat store, whose sole remaining
  // writer is the pending-interactions recovery path — so "Working" never
  // appeared in the sidebar (user report 2026-06-11).
  describe('stream-store and list-store sources', () => {
    it('shows streaming from the per-session stream store with no chat-store entry', () => {
      hydrateStreamSession('streaming');
      const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
      expect(result.current.kind).toBe('streaming');
    });

    it('shows pendingApproval when the stream store holds pending interactions', () => {
      hydrateStreamSession('blocked', 1);
      const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
      expect(result.current.kind).toBe('pendingApproval');
    });

    it('shows streaming from a session_status fan-out for a never-hydrated session', () => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        cwd: '/work/alpha',
        status: statusWithLifecycle('streaming'),
      });
      const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
      expect(result.current.kind).toBe('streaming');
    });

    it('maps a blocked list-store lifecycle to pendingApproval', () => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        status: statusWithLifecycle('blocked'),
      });
      const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
      expect(result.current.kind).toBe('pendingApproval');
    });

    it('maps an error lifecycle to error', () => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        status: statusWithLifecycle('error'),
      });
      const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
      expect(result.current.kind).toBe('error');
    });

    it('treats interrupted as idle — no false activity signal', () => {
      hydrateStreamSession('interrupted');
      const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
      expect(result.current.kind).toBe('idle');
    });

    it('settles back to idle when a session_removed clears the status', () => {
      const store = useSessionListStore.getState();
      store.applyListEvent({
        type: 'session_status',
        sessionId: SESSION_ID,
        status: statusWithLifecycle('streaming'),
      });
      store.applyListEvent({ type: 'session_removed', sessionId: SESSION_ID });
      const { result } = renderHook(() => useSessionBorderState(SESSION_ID));
      expect(result.current.kind).toBe('idle');
    });
  });
});
