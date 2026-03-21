/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ActivityEvent } from '../model/use-activity-feed';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

import { ActivityFeedItem } from '../ui/ActivityFeedItem';

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'event-1',
    type: 'session',
    timestamp: new Date().toISOString(),
    title: 'Test session completed (2h)',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityFeedItem', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders event title', () => {
    render(<ActivityFeedItem event={makeEvent({ title: 'researcher completed (47m)' })} />);
    expect(screen.getByText('researcher completed (47m)')).toBeInTheDocument();
  });

  it('renders type label for session events', () => {
    render(<ActivityFeedItem event={makeEvent({ type: 'session' })} />);
    expect(screen.getByText('Session')).toBeInTheDocument();
  });

  it('renders type label for pulse events', () => {
    render(<ActivityFeedItem event={makeEvent({ type: 'pulse' })} />);
    expect(screen.getByText('Pulse')).toBeInTheDocument();
  });

  it('shows Open button only when event has a link', () => {
    const { rerender } = render(<ActivityFeedItem event={makeEvent()} />);
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();

    rerender(
      <ActivityFeedItem
        event={makeEvent({ link: { to: '/session', params: { session: 'sess-1' } } })}
      />
    );
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('applies blue border accent when isNew is true', () => {
    const { container } = render(<ActivityFeedItem event={makeEvent()} isNew />);
    const row = container.querySelector('.border-l-2');
    expect(row).toBeInTheDocument();
  });

  it('does not apply border accent when isNew is false', () => {
    const { container } = render(<ActivityFeedItem event={makeEvent()} />);
    const row = container.querySelector('.border-l-2');
    expect(row).not.toBeInTheDocument();
  });

  it('renders type dot with correct color class for session', () => {
    const { container } = render(<ActivityFeedItem event={makeEvent({ type: 'session' })} />);
    const dot = container.querySelector('.bg-blue-500');
    expect(dot).toBeInTheDocument();
  });

  it('renders type dot with correct color class for pulse', () => {
    const { container } = render(<ActivityFeedItem event={makeEvent({ type: 'pulse' })} />);
    const dot = container.querySelector('.bg-purple-500');
    expect(dot).toBeInTheDocument();
  });
});
