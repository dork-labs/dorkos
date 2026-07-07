/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionStatus, SessionLifecycle } from '@dorkos/shared/session-stream';
import { useSessionChatStore } from '../session-chat-store';
import { useSessionStreamStore } from '../session-stream-store';
import { useSessionListStore } from '../session-list-store';
import { useAgentHottestStatus } from '../use-agent-hottest-status';

vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, useReducedMotion: () => false };
});

const AGENT_PATH = '/work/alpha';
const A = 'session-a';
const B = 'session-b';

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
  };
}

function pushStatus(sessionId: string, lifecycle: SessionLifecycle, cwd?: string) {
  useSessionListStore.getState().applyListEvent({
    type: 'session_status',
    sessionId,
    cwd,
    status: statusWithLifecycle(lifecycle),
  });
}

describe('useAgentHottestStatus', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {} });
  });

  it('returns idle when no source has a signal', () => {
    const { result } = renderHook(() => useAgentHottestStatus([A, B], AGENT_PATH));
    expect(result.current.kind).toBe('idle');
  });

  it('still reads the legacy chat store', () => {
    useSessionChatStore.getState().updateSession(A, { sdkState: 'running' });
    const { result } = renderHook(() => useAgentHottestStatus([A], AGENT_PATH));
    expect(result.current.kind).toBe('streaming');
  });

  it('reads stream-store pending interactions as pendingApproval', () => {
    useSessionStreamStore.getState().applySnapshot(B, {
      messages: [],
      inProgressTurn: null,
      status: statusWithLifecycle('blocked'),
      pendingInteractions: [
        {
          id: 'int-1',
          type: 'approval',
          startedAt: 1000,
          remainingMs: 30000,
          toolName: 'Bash',
          input: '{}',
          hasSuggestions: false,
        },
      ],
      cursor: 1,
    });
    const { result } = renderHook(() => useAgentHottestStatus([A, B], AGENT_PATH));
    expect(result.current.kind).toBe('pendingApproval');
  });

  it('reads session_status fan-outs for the given session ids', () => {
    pushStatus(B, 'streaming');
    const { result } = renderHook(() => useAgentHottestStatus([A, B], AGENT_PATH));
    expect(result.current.kind).toBe('streaming');
  });

  // The collapsed-agent case (user report 2026-06-11): the sidebar passes
  // sessions=[] for every non-active agent, so id-based scans see nothing.
  // The cwd carried on session_status is the only signal that can light the
  // row up.
  it('lights up a collapsed agent (no session ids) via cwd-matched fan-outs', () => {
    pushStatus('unknown-session', 'streaming', AGENT_PATH);
    const { result } = renderHook(() => useAgentHottestStatus([], AGENT_PATH));
    expect(result.current.kind).toBe('streaming');
  });

  it('ignores fan-outs from other working directories', () => {
    pushStatus('unknown-session', 'streaming', '/work/other');
    const { result } = renderHook(() => useAgentHottestStatus([], AGENT_PATH));
    expect(result.current.kind).toBe('idle');
  });

  it('picks the hottest signal across sources: blocked cwd-match beats legacy streaming', () => {
    useSessionChatStore.getState().updateSession(A, { sdkState: 'running' });
    pushStatus('unknown-session', 'blocked', AGENT_PATH);
    const { result } = renderHook(() => useAgentHottestStatus([A], AGENT_PATH));
    expect(result.current.kind).toBe('pendingApproval');
  });

  it('settles when the cwd-matched session goes idle', () => {
    pushStatus('unknown-session', 'streaming', AGENT_PATH);
    pushStatus('unknown-session', 'idle', AGENT_PATH);
    const { result } = renderHook(() => useAgentHottestStatus([], AGENT_PATH));
    expect(result.current.kind).toBe('idle');
  });
});
