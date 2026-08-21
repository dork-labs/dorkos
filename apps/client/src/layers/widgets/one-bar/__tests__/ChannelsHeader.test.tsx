// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ChannelsHeader } from '../ui/ChannelsHeader';
import { BarHarness } from './bar-harness';

// The fixed cluster OneBar renders. Both are real widgets with their own data
// needs; this suite is about what the BAR says, so they are stubbed at the seam.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

afterEach(() => {
  cleanup();
});

function renderHeader(roomTitle: string | null) {
  return render(
    <BarHarness roomTitle={roomTitle}>
      <ChannelsHeader />
    </BarHarness>
  );
}

describe('ChannelsHeader', () => {
  it('names the open room', () => {
    renderHeader('#general');
    expect(screen.getByText('#general')).toBeInTheDocument();
  });

  it('falls back to the route name when no room is open', () => {
    // The real component owns this fallback — the app-shell slot test mocks
    // ChannelsHeader, so only this file can catch a broken `?? 'Channels'`.
    renderHeader(null);
    expect(screen.getByText('Channels')).toBeInTheDocument();
  });

  it('truncates a long room title instead of blowing the header open', () => {
    // The first OneBar caller with user-controlled title text (up to 200
    // chars; bridged rooms arrive from outside our control). Regression pin
    // for the 36px-header overflow found in review.
    const long = 'Priya, Kai, Ikechi and 47 others about the quarterly migration plan';
    renderHeader(long);
    const title = screen.getByText(long);
    expect(title).toHaveClass('truncate', 'min-w-0');
    expect(title).toHaveAttribute('title', long);
  });
});
