/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type RouteRoom = { status: 'none' } | { status: 'loading' } | { status: 'ready'; roomId: string };
type AgentQuery = { data: { id: string } | null | undefined; isPending: boolean };

let mockRoom: RouteRoom = { status: 'none' };
let mockAgent: AgentQuery = { data: undefined, isPending: true };
let mockSelectedCwd: string | null = null;
const mockUseCurrentAgent = vi.fn((_cwd: string | null) => mockAgent);

vi.mock('@/layers/entities/room', () => ({
  useRouteRoom: () => mockRoom,
}));
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: (cwd: string | null) => mockUseCurrentAgent(cwd),
}));
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ selectedCwd: mockSelectedCwd }),
}));

import { usePlacementHere } from '../model/use-placement-here';

beforeEach(() => {
  mockRoom = { status: 'none' };
  mockAgent = { data: undefined, isPending: true };
  mockSelectedCwd = null;
  mockUseCurrentAgent.mockClear();
});

describe('usePlacementHere', () => {
  it('in a chat, names the session page and the agent at the chat folder', () => {
    mockSelectedCwd = '/projects/alpha';
    mockAgent = { data: { id: 'agent-1' }, isPending: false };

    const { result } = renderHook(() => usePlacementHere('/session', false));

    expect(result.current).toEqual({
      status: 'ready',
      here: { page: 'session', agentId: 'agent-1' },
    });
    expect(mockUseCurrentAgent).toHaveBeenCalledWith('/projects/alpha');
  });

  it('in a chat with no registered agent, is ready with a null agent', () => {
    mockSelectedCwd = '/projects/alpha';
    mockAgent = { data: null, isPending: false };

    const { result } = renderHook(() => usePlacementHere('/session', false));

    expect(result.current).toEqual({ status: 'ready', here: { page: 'session', agentId: null } });
  });

  it('is pending while the chat agent resolves, handing back the last answer', () => {
    mockSelectedCwd = '/projects/alpha';
    mockAgent = { data: { id: 'agent-1' }, isPending: false };
    const { result, rerender } = renderHook(
      ({ pathname }: { pathname: string }) => usePlacementHere(pathname, false),
      { initialProps: { pathname: '/session' } }
    );
    const settled = { page: 'session', agentId: 'agent-1' };
    expect(result.current).toEqual({ status: 'ready', here: settled });

    // The person switches to another project: its agent has not loaded yet.
    mockSelectedCwd = '/projects/beta';
    mockAgent = { data: undefined, isPending: true };
    rerender({ pathname: '/session' });

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
    mockSelectedCwd = '/projects/alpha';
    mockAgent = { data: undefined, isPending: true };

    const { result } = renderHook(() => usePlacementHere('/session', false));

    expect(result.current).toEqual({ status: 'pending', last: null });
  });

  it('in a chat with no folder selected, is ready rather than waiting on a disabled query', () => {
    mockSelectedCwd = null;
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
    mockSelectedCwd = '/projects/alpha';
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
