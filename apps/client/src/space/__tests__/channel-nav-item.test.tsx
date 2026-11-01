// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelNavItem } from '../components/nav/ChannelNavItem.js';
import type { Channel } from '../types.js';

// DOR-3593: the DorkOS app numbers only what is aimed at you. This list carries
// no mention count and no direct messages, so a busy channel is a bold name
// and never a number.

function channel(unreadCount: number): Channel {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    name: 'general',
    description: null,
    visibility: 'public',
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    joined: true,
    unreadCount,
  };
}

afterEach(cleanup);

describe('a channel in the space’s list', () => {
  it('is bold with no number when it has new messages', () => {
    render(<ChannelNavItem channel={channel(140)} active={false} onChoose={() => {}} />);
    const button = screen.getByRole('button', { name: 'general, new messages' });
    expect(button.textContent).not.toMatch(/\d/);
    expect(screen.getByText('general').className).toContain('font-semibold');
  });

  it('is plain, and says nothing more, once it is read', () => {
    render(<ChannelNavItem channel={channel(0)} active={false} onChoose={() => {}} />);
    screen.getByRole('button', { name: 'general' });
    expect(screen.getByText('general').className).not.toContain('font-semibold');
  });

  it('opens the channel when chosen', () => {
    const onChoose = vi.fn();
    render(<ChannelNavItem channel={channel(2)} active onChoose={onChoose} />);
    fireEvent.click(screen.getByRole('button', { name: 'general, new messages' }));
    expect(onChoose).toHaveBeenCalledOnce();
  });
});
