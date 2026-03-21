/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Session } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSessions = vi.fn<() => { sessions: Session[] }>(() => ({ sessions: [] }));
vi.mock('@/layers/entities/session', () => ({
  useSessions: () => mockSessions(),
}));

const mockResolvedAgents = vi.fn<() => { data: Record<string, AgentManifest | null> | undefined }>(
  () => ({ data: undefined })
);
vi.mock('@/layers/entities/agent', () => ({
  useResolvedAgents: () => mockResolvedAgents(),
}));

// Import after mocks
import { useActiveSessions, formatElapsed } from '../model/use-active-sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: 'sess-1',
    title: 'Test Session',
    createdAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(), // 10 min ago
    updatedAt: now.toISOString(),
    lastMessagePreview: 'Hello world',
    permissionMode: 'default',
    cwd: '/projects/myapp',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'agent-1',
    name: 'My Agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: new Date().toISOString(),
    registeredBy: 'test',
    personaEnabled: true,
    color: '#6366f1',
    icon: '🤖',
    ...overrides,
  } as AgentManifest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useActiveSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.mockReturnValue({ sessions: [] });
    mockResolvedAgents.mockReturnValue({ data: undefined });
  });

  it('returns empty array when no sessions exist', () => {
    mockSessions.mockReturnValue({ sessions: [] });
    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions).toHaveLength(0);
    expect(result.current.totalCount).toBe(0);
  });

  it('filters sessions to those updated within 2 hours', () => {
    const recent = makeSession({ id: 'recent', updatedAt: new Date().toISOString() });
    const twoHoursAndOneMinuteAgo = new Date(Date.now() - 121 * 60 * 1000).toISOString();
    const old = makeSession({ id: 'old', updatedAt: twoHoursAndOneMinuteAgo });

    mockSessions.mockReturnValue({ sessions: [recent, old] });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe('recent');
    expect(result.current.totalCount).toBe(1);
  });

  it('totalCount reflects all recent sessions before cap', () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      makeSession({ id: `sess-${i}`, cwd: `/projects/app-${i}` })
    );
    mockSessions.mockReturnValue({ sessions });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions).toHaveLength(6);
    expect(result.current.totalCount).toBe(8);
  });

  it('caps displayed sessions at 6', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession({ id: `sess-${i}`, cwd: `/projects/app-${i}` })
    );
    mockSessions.mockReturnValue({ sessions });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions).toHaveLength(6);
  });

  it('marks sessions updated within 5 minutes as active', () => {
    const activeSession = makeSession({
      id: 'active',
      updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
    });
    mockSessions.mockReturnValue({ sessions: [activeSession] });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions[0].status).toBe('active');
  });

  it('marks sessions not updated within 5 minutes as idle', () => {
    const idleSession = makeSession({
      id: 'idle',
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    });
    mockSessions.mockReturnValue({ sessions: [idleSession] });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions[0].status).toBe('idle');
  });

  it('resolves agent identity from useResolvedAgents', () => {
    const session = makeSession({ cwd: '/projects/myapp' });
    mockSessions.mockReturnValue({ sessions: [session] });

    const agent = makeAgent({ name: 'Backend Bot', icon: '🔧', color: '#ff0000' });
    mockResolvedAgents.mockReturnValue({ data: { '/projects/myapp': agent } });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions[0].agentName).toBe('Backend Bot');
    expect(result.current.sessions[0].agentEmoji).toBe('🔧');
    expect(result.current.sessions[0].agentColor).toBe('#ff0000');
  });

  it('falls back to cwd basename when no agent manifest found', () => {
    const session = makeSession({ cwd: '/projects/myapp' });
    mockSessions.mockReturnValue({ sessions: [session] });
    mockResolvedAgents.mockReturnValue({ data: { '/projects/myapp': null } });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions[0].agentName).toBe('myapp');
  });

  it('shows empty agentEmoji and agentColor when no agent manifest', () => {
    const session = makeSession({ cwd: '/projects/myapp' });
    mockSessions.mockReturnValue({ sessions: [session] });
    mockResolvedAgents.mockReturnValue({ data: { '/projects/myapp': null } });

    const { result } = renderHook(() => useActiveSessions());
    expect(result.current.sessions[0].agentEmoji).toBe('');
    expect(result.current.sessions[0].agentColor).toBe('');
  });
});

describe('formatElapsed', () => {
  it('returns minutes for durations under 1 hour', () => {
    expect(formatElapsed(30 * 60 * 1000)).toBe('30m');
  });

  it('returns hours and minutes for durations under 24 hours', () => {
    expect(formatElapsed(90 * 60 * 1000)).toBe('1h 30m');
  });

  it('returns days for durations 24 hours or more', () => {
    expect(formatElapsed(48 * 60 * 60 * 1000)).toBe('2d');
  });

  it('returns 0m for zero duration', () => {
    expect(formatElapsed(0)).toBe('0m');
  });
});
