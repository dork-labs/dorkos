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
  },
  roomQuery: vi.fn(),
}));
vi.mock('@/layers/entities/community', () => ({
  communityAccessState: () => ({
    capabilities: { read: true },
    fingerprint: 'fp',
  }),
  useCommunityConnections: () => ({ data: state.connections }),
  useRemoteCommunityRoom: (...args: unknown[]) => {
    roomQuery(...args);
    return { data: state.roomTitle ? { title: state.roomTitle } : undefined };
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.connections = [{ ref: 'alpha', label: 'Alpha', access: null }];
  state.roomTitle = 'General';
});

describe('CommunityPageHeading', () => {
  it('says the Community, then the channel', () => {
    render(<CommunityPageHeading community="alpha" roomId="room-1" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Alpha · General');
    expect(roomQuery).toHaveBeenCalledWith('alpha', 'room-1', true, 'fp');
  });

  it('says the Community alone until the channel’s name arrives', () => {
    state.roomTitle = undefined;
    render(<CommunityPageHeading community="alpha" roomId="room-1" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Alpha$/);
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
