// @vitest-environment jsdom
/**
 * A Community page's heading names the Community and then the channel, so a
 * person who just switched hears both halves of where they are.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CommunityPageHeading } from '../ui/CommunityPageHeading';

const { state, roomQuery } = vi.hoisted(() => ({
  state: {
    connections: [{ ref: 'alpha', label: 'Alpha', access: null }] as
      Array<{ ref: string; label: string; access: null }> | undefined,
    roomTitle: 'General' as string | undefined,
    roomFetch: 'idle' as 'idle' | 'fetching',
  },
  roomQuery: vi.fn(),
}));
vi.mock('@/layers/entities/community', () => ({
  communityAccessState: () => ({
    capabilities: { read: true },
    fingerprint: 'fp',
  }),
  useCommunityConnections: () => ({ data: state.connections, fetchStatus: 'idle' }),
  useRemoteCommunityRoom: (...args: unknown[]) => {
    roomQuery(...args);
    return {
      data: state.roomTitle ? { title: state.roomTitle } : undefined,
      fetchStatus: state.roomFetch,
    };
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.connections = [{ ref: 'alpha', label: 'Alpha', access: null }];
  state.roomTitle = 'General';
  state.roomFetch = 'idle';
});

describe('CommunityPageHeading', () => {
  it('says the Community, then the channel', () => {
    render(<CommunityPageHeading community="alpha" roomId="room-1" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Alpha · General');
    expect(roomQuery).toHaveBeenCalledWith('alpha', 'room-1', true, 'fp');
  });

  it('says the Community alone until the channel’s name arrives, and marks itself unfinished', () => {
    state.roomTitle = undefined;
    state.roomFetch = 'fetching';
    render(<CommunityPageHeading community="alpha" roomId="room-1" />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/^Alpha$/);
    expect(heading).toHaveAttribute('data-pending');
  });

  it('is finished once the name is in, or when no name is coming', () => {
    render(<CommunityPageHeading community="alpha" roomId="room-1" />);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('data-pending');
    cleanup();
    // The channel cannot be read, so its name is not being fetched at all.
    state.roomTitle = undefined;
    render(<CommunityPageHeading community="alpha" roomId="room-1" />);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('data-pending');
  });

  it('asks for no channel when the route names none', () => {
    render(<CommunityPageHeading community="alpha" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Alpha$/);
    expect(roomQuery).toHaveBeenCalledWith('alpha', '', false, 'fp');
  });

  it('falls back to a word it can say honestly before the connection list lands', () => {
    state.connections = undefined;
    render(<CommunityPageHeading community="alpha" roomId="room-1" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Community · General');
  });
});
