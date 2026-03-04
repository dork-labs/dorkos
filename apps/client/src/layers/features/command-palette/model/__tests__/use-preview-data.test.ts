/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Session fixtures — cwd matches Session schema (optional string)
const mockSessions = [
  {
    id: 's1',
    title: 'Fix auth bug',
    cwd: '/projects/auth',
    updatedAt: '2026-03-03T10:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    permissionMode: 'default' as const,
  },
  {
    id: 's2',
    title: 'Add endpoint',
    cwd: '/projects/auth',
    updatedAt: '2026-03-03T09:00:00.000Z',
    createdAt: '2026-03-03T08:00:00.000Z',
    permissionMode: 'default' as const,
  },
  {
    id: 's3',
    title: 'Refactor models',
    cwd: '/projects/auth',
    updatedAt: '2026-03-02T10:00:00.000Z',
    createdAt: '2026-03-02T09:00:00.000Z',
    permissionMode: 'default' as const,
  },
  {
    id: 's4',
    title: 'Deploy pipeline',
    cwd: '/projects/auth',
    updatedAt: '2026-03-01T10:00:00.000Z',
    createdAt: '2026-03-01T09:00:00.000Z',
    permissionMode: 'default' as const,
  },
  {
    id: 's5',
    title: 'API work',
    cwd: '/projects/api',
    updatedAt: '2026-03-03T10:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    permissionMode: 'default' as const,
  },
];

const mockHealth = { status: 'healthy' as const, lastHeartbeat: '2026-03-03T10:00:00Z' };

vi.mock('@/layers/entities/session', () => ({
  useSessions: () => ({
    sessions: mockSessions,
    isLoading: false,
    createSession: { mutate: vi.fn(), isPending: false },
    activeSessionId: null,
    setActiveSession: vi.fn(),
  }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentHealth: (id: string | null) => ({
    data: id === 'agent-1' ? mockHealth : undefined,
  }),
}));

describe('usePreviewData', () => {
  it('returns session count for the agent CWD', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-1', '/projects/auth'));
    expect(result.current.sessionCount).toBe(4);
  });

  it('returns at most 3 recent sessions', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-1', '/projects/auth'));
    expect(result.current.recentSessions).toHaveLength(3);
  });

  it('returns health data when available', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-1', '/projects/auth'));
    expect(result.current.health).toEqual(mockHealth);
  });

  it('returns null health when agent has no health data', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-unknown', '/projects/unknown'));
    expect(result.current.health).toBeNull();
  });

  it('filters sessions by agent CWD correctly', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-2', '/projects/api'));
    expect(result.current.sessionCount).toBe(1);
  });

  it('returns 0 sessions for unmatched CWD', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-x', '/projects/nonexistent'));
    expect(result.current.sessionCount).toBe(0);
    expect(result.current.recentSessions).toHaveLength(0);
  });

  it('maps session updatedAt to lastActive in recentSessions', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-1', '/projects/auth'));
    const first = result.current.recentSessions[0];
    expect(first.lastActive).toBe('2026-03-03T10:00:00.000Z');
  });

  it('maps session title correctly in recentSessions', async () => {
    const { usePreviewData } = await import('../use-preview-data');
    const { result } = renderHook(() => usePreviewData('agent-1', '/projects/auth'));
    const first = result.current.recentSessions[0];
    expect(first.id).toBe('s1');
    expect(first.title).toBe('Fix auth bug');
  });
});
