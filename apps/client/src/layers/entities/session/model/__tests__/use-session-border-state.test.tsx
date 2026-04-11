/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionChatStore, type SessionState } from '../session-chat-store';
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

describe('useSessionBorderState', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    reducedMotionRef.value = false;
  });

  it('returns idle kind for a session with no store entry', () => {
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('idle');
    expect(result.current.pulse).toBe(false);
    expect(result.current.color).toBe('rgba(128, 128, 128, 0.08)');
  });

  it('returns active kind when isActive is true and no higher-priority state', () => {
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, true));
    expect(result.current.kind).toBe('active');
    expect(result.current.pulse).toBe(false);
  });

  it('returns streaming kind when status is streaming', () => {
    setSession({ status: 'streaming' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('streaming');
    expect(result.current.pulse).toBe(true);
    expect(result.current.dimColor).toBeDefined();
  });

  it('returns streaming kind when sdkState is running', () => {
    setSession({ sdkState: 'running' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('streaming');
  });

  it('returns error kind when status is error', () => {
    setSession({ status: 'error' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('error');
    expect(result.current.pulse).toBe(false);
  });

  it('returns unseen kind when hasUnseenActivity is true', () => {
    setSession({ hasUnseenActivity: true });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('unseen');
  });

  it('detects pending approval from sdkState=requires_action', () => {
    setSession({ sdkState: 'requires_action' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
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
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('pendingApproval');
  });

  // Priority matrix
  it('pending approval beats active (active row must still surface approval)', () => {
    setSession({ sdkState: 'requires_action' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, true));
    expect(result.current.kind).toBe('pendingApproval');
  });

  it('pending approval beats streaming', () => {
    setSession({ status: 'streaming', sdkState: 'requires_action' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('pendingApproval');
  });

  it('active beats streaming', () => {
    setSession({ status: 'streaming' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, true));
    expect(result.current.kind).toBe('active');
  });

  it('active beats error', () => {
    setSession({ status: 'error' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, true));
    expect(result.current.kind).toBe('active');
  });

  it('active beats unseen activity', () => {
    setSession({ hasUnseenActivity: true });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, true));
    expect(result.current.kind).toBe('active');
  });

  it('streaming beats error when not active', () => {
    setSession({ status: 'streaming' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('streaming');
  });

  it('error beats unseen activity', () => {
    setSession({ status: 'error', hasUnseenActivity: true });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('error');
  });

  // Reduced motion
  it('suppresses pulse when prefers-reduced-motion is set', () => {
    reducedMotionRef.value = true;
    setSession({ status: 'streaming' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('streaming');
    expect(result.current.pulse).toBe(false);
  });

  it('suppresses pulse for pending approval when reduced motion is set', () => {
    reducedMotionRef.value = true;
    setSession({ sdkState: 'requires_action' });
    const { result } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(result.current.kind).toBe('pendingApproval');
    expect(result.current.pulse).toBe(false);
  });

  // Labels
  it('provides human-readable labels for every kind', () => {
    const { result: idle } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(idle.current.label).toBe('Idle');

    setSession({ status: 'streaming' });
    const { result: streaming } = renderHook(() => useSessionBorderState(SESSION_ID, false));
    expect(streaming.current.label).toBe('Streaming response');
  });
});
