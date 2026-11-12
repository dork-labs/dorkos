/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type RouteRoom = { status: 'none' } | { status: 'loading' } | { status: 'ready'; roomId: string };
type AgentQuery = { data: { id: string } | null | undefined; isPending: boolean };

let mockRoom: RouteRoom = { status: 'none' };
let mockAgent: AgentQuery = { data: undefined, isPending: true };
const mockUseCurrentAgent = vi.fn((_cwd: string | null) => mockAgent);

vi.mock('@/layers/entities/room', () => ({
  useRouteRoom: () => mockRoom,
}));
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: (cwd: string | null) => mockUseCurrentAgent(cwd),
}));
// The chat folder comes from the REAL app store, seeded per case.
import { useAppStore } from '@/layers/shared/model';
import { usePlacementHere } from '../model/use-placement-here';

const selectFolder = (cwd: string | null) => act(() => useAppStore.setState({ selectedCwd: cwd }));

beforeEach(() => {
  mockRoom = { status: 'none' };
  mockAgent = { data: undefined, isPending: true };
  selectFolder(null);
  mockUseCurrentAgent.mockClear();
});

describe('usePlacementHere', () => {
  it('in a chat, names the session page and the agent at the chat folder', () => {
    selectFolder('/projects/alpha');
    mockAgent = { data: { id: 'agent-1' }, isPending: false };

    const { result } = renderHook(() => usePlacementHere('/session', false));

    expect(result.current).toEqual({
      status: 'ready',
      here: { page: 'session', agentId: 'agent-1' },
    });
    expect(mockUseCurrentAgent).toHaveBeenCalledWith('/projects/alpha');
  });

  it('in a chat with no registered agent, is ready with a null agent', () => {
    selectFolder('/projects/alpha');
    mockAgent = { data: null, isPending: false };

    const { result } = renderHook(() => usePlacementHere('/session', false));

    expect(result.current).toEqual({ status: 'ready', here: { page: 'session', agentId: null } });
  });

  it('is pending while the chat agent resolves, handing back the last answer', () => {
    selectFolder('/projects/alpha');
    mockAgent = { data: { id: 'agent-1' }, isPending: false };
    const { result, rerender } = renderHook(
      ({ pathname }: { pathname: string }) => usePlacementHere(pathname, false),
      { initialProps: { pathname: '/session' } }
    );
    const settled = { page: 'session', agentId: 'agent-1' };
    expect(result.current).toEqual({ status: 'ready', here: settled });

    // The person switches to another project: its agent has not loaded yet.
    // The agent query goes pending first, so the store write's own re-render
    // already sees the new folder with nothing loaded for it.
    mockAgent = { data: undefined, isPending: true };
    selectFolder('/projects/beta');
    rerender({ pathname: '/session' });

    expect(mockUseCurrentAgent).toHaveBeenLastCalledWith('/projects/beta');

    expect(result.current).toEqual({ status: 'pending', last: settled });

    // Once it lands, the new agent is the answer.
    mockAgent = { data: { id: 'agent-2' }, isPending: false };
    rerender({ pathname: '/session' });
    expect(result.current).toEqual({
      status: 'ready',
      here: { page: 'session', agentId: 'agent-2' },
    });
  });

  it('is pending with no last answer when the first render is still resolving', () => {
    selectFolder('/projects/alpha');
    mockAgent = { data: undefined, isPending: true };

    const { result } = renderHook(() => usePlacementHere('/session', false));

    expect(result.current).toEqual({ status: 'pending', last: null });
  });

  it('in a chat with no folder selected, is ready rather than waiting on a disabled query', () => {
    selectFolder(null);
    // A disabled query reports `isPending: true` forever.
    mockAgent = { data: undefined, isPending: true };

    const { result } = renderHook(() => usePlacementHere('/session', false));

    expect(result.current).toEqual({ status: 'ready', here: { page: 'session', agentId: null } });
    expect(mockUseCurrentAgent).toHaveBeenCalledWith(null);
  });

  it('in a channel on this computer, names the room', () => {
    mockRoom = { status: 'ready', roomId: 'R1' };

    const { result } = renderHook(() => usePlacementHere('/channels', false));

    expect(result.current).toEqual({ status: 'ready', here: { page: 'channels', roomId: 'R1' } });
  });

  it('in a channel from a connected community, names only the page', () => {
    mockRoom = { status: 'ready', roomId: 'R1' };

    const { result } = renderHook(() => usePlacementHere('/channels', true));

    expect(result.current).toEqual({ status: 'ready', here: { page: 'channels' } });
  });

  it('on Home while #team is still loading, is pending', () => {
    mockRoom = { status: 'loading' };

    const { result } = renderHook(() => usePlacementHere('/', false));

    expect(result.current).toEqual({ status: 'pending', last: null });
  });

  it('on Home once #team resolves, names the home page and the room', () => {
    mockRoom = { status: 'ready', roomId: 'team-room' };

    const { result } = renderHook(() => usePlacementHere('/', false));

    expect(result.current).toEqual({
      status: 'ready',
      here: { page: 'home', roomId: 'team-room' },
    });
  });

  it('elsewhere, names only the page and never asks for the agent', () => {
    selectFolder('/projects/alpha');
    mockAgent = { data: { id: 'agent-1' }, isPending: false };

    const { result } = renderHook(() => usePlacementHere('/activity', false));

    expect(result.current).toEqual({ status: 'ready', here: { page: 'activity' } });
    expect(mockUseCurrentAgent).toHaveBeenCalledWith(null);
  });

  it('returns the same object while the place does not change', () => {
    mockRoom = { status: 'ready', roomId: 'R1' };
    const { result, rerender } = renderHook(() => usePlacementHere('/channels', false));
    const first = result.current as { status: 'ready'; here: object };
    rerender();
    expect(first.status).toBe('ready');
    expect(result.current).toEqual({ status: 'ready', here: first.here });
    expect((result.current as { here: object }).here).toBe(first.here);
  });
});
