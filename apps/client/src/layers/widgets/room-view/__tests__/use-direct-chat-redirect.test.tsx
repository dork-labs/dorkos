// @vitest-environment jsdom
/**
 * One door to an agent (rule S12, DOR-2997): the person's DM with one agent
 * opens as that agent's Direct chat, and every other room stays a room.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { useDirectChatRedirect } from '../model/use-direct-chat-redirect';

const { state } = vi.hoisted(() => ({
  state: { rooms: undefined as RoomSummary[] | undefined },
}));
const open = vi.hoisted(() => vi.fn());

vi.mock('@/layers/entities/room', () => ({
  useRooms: () => ({ data: state.rooms, isError: false }),
  useOpenDirectChat: () => open,
}));

function dm(id: string, participants: Array<'human' | 'agent'>, bridge = null): RoomSummary {
  return {
    id,
    kind: 'dm',
    bridge,
    participants: participants.map((kind, i) => ({
      id: `${kind}-${i}`,
      kind,
      displayName: kind,
      ...(kind === 'agent' && { agentRef: `ref-${i}` }),
    })),
  } as unknown as RoomSummary;
}

afterEach(() => {
  vi.clearAllMocks();
  state.rooms = undefined;
});

describe('useDirectChatRedirect', () => {
  it('opens a one-agent DM as that agent’s Direct chat, replacing the address', async () => {
    state.rooms = [dm('dm-ana', ['human', 'agent'])];
    open.mockResolvedValue(true);

    const { result } = renderHook(() => useDirectChatRedirect('dm-ana'));

    expect(result.current).toBe('redirecting');
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({ roomId: 'dm-ana' }, { replace: true, quiet: true })
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('draws nothing until it knows which room this is', () => {
    const { result } = renderHook(() => useDirectChatRedirect('dm-ana'));
    expect(result.current).toBe('pending');
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps a DM with two agents a room', () => {
    state.rooms = [dm('dm-group', ['human', 'agent', 'agent'])];
    const { result } = renderHook(() => useDirectChatRedirect('dm-group'));
    expect(result.current).toBe('show');
    expect(open).not.toHaveBeenCalled();
  });

  it('draws the room after all when the Direct chat cannot be opened', async () => {
    state.rooms = [dm('dm-ana', ['human', 'agent'])];
    open.mockResolvedValue(false);

    const { result } = renderHook(() => useDirectChatRedirect('dm-ana'));

    await waitFor(() => expect(result.current).toBe('show'));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
