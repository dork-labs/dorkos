// @vitest-environment jsdom
/**
 * What a DM calls its agent when the answers are slow or never come (DOR-3074):
 * nothing while they are on their way, and a name once the wait has a limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AGENT_IDENTITY_LIMIT_MS } from '@/layers/shared/lib';
import { useDirectMessageAgent } from '../model/use-direct-message-agent';

const data = vi.hoisted(() => ({
  manifest: { data: undefined, isPending: true } as { data: unknown; isPending: boolean },
  rooms: { data: undefined, isPending: true } as { data: unknown; isPending: boolean },
}));

vi.mock('@/layers/entities/agent', () => ({ useCurrentAgent: () => data.manifest }));
vi.mock('@/layers/entities/team', () => ({
  useTeamRoster: () => ({ data: undefined }),
  useMemberRooms: () => ({ data: undefined }),
}));
vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRooms: () => data.rooms,
}));

const KEPT_NAME = {
  data: [
    {
      id: 'dm',
      participants: [{ id: 'a', kind: 'agent', displayName: 'Tern' }],
    },
  ],
  isPending: false,
};

describe('useDirectMessageAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    data.manifest = { data: undefined, isPending: true };
    data.rooms = { data: undefined, isPending: true };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names nobody while the manifest is on its way', () => {
    const { result } = renderHook(() => useDirectMessageAgent('/a', 'dm'));
    act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS - 1));
    expect(result.current).toMatchObject({ name: null, pending: true, unknown: false });
  });

  it('says "Unknown agent" at the limit when nothing answers, still waiting', () => {
    const { result } = renderHook(() => useDirectMessageAgent('/a', 'dm'));
    act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS));
    expect(result.current).toMatchObject({
      name: 'Unknown agent',
      pending: true,
      unknown: true,
    });
  });

  it('uses the kept name at the limit if the room has answered', () => {
    data.rooms = KEPT_NAME;
    const { result } = renderHook(() => useDirectMessageAgent('/a', 'dm'));
    act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS));
    expect(result.current).toMatchObject({ name: 'Tern', unknown: false });
  });

  it('caps a room list that hangs after the manifest said there is none', () => {
    data.manifest = { data: null, isPending: false };
    const { result } = renderHook(() => useDirectMessageAgent('/a', 'dm'));
    expect(result.current).toMatchObject({ name: null, pending: true });
    act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS));
    expect(result.current).toMatchObject({ name: 'Unknown agent', unknown: true });
  });

  it('takes the real name when a late manifest comes', () => {
    const { result, rerender } = renderHook(() => useDirectMessageAgent('/a', 'dm'));
    act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS));
    data.manifest = {
      data: { id: 'tern', name: 'tern', displayName: 'Tern' },
      isPending: false,
    };
    rerender();
    expect(result.current).toMatchObject({ name: 'Tern', pending: false, unknown: false });
  });

  it('stays out of it without a DM to read', () => {
    const { result } = renderHook(() => useDirectMessageAgent(null));
    act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS));
    expect(result.current).toMatchObject({ name: null, pending: false, unknown: false });
  });
});
