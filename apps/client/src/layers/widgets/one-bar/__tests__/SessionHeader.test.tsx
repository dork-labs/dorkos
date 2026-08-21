// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { SessionOrigin } from '@dorkos/shared/types';
import { SessionHeader } from '../ui/SessionHeader';
import { BarHarness } from './bar-harness';

// The fixed cluster OneBar renders. Both are real widgets with their own data
// needs; this suite is about what the BAR says, so they are stubbed at the seam.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

// Mock app store (used by CommandPaletteTrigger)
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setGlobalPaletteOpen: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Mock TanStack Router Link to a plain anchor
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...rest
  }: { children: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
      {children}
    </a>
  ),
}));

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

function renderBar(state: { agentName?: string; origin?: SessionOrigin; originLabel?: string }) {
  return render(
    <BarHarness {...state}>
      <SessionHeader />
    </BarHarness>
  );
}

describe('SessionHeader', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders agent name in breadcrumb', () => {
    renderBar({ agentName: 'dorkbot' });
    expect(screen.getByText('dorkbot')).toBeInTheDocument();
  });

  it('renders Team link pointing to /team', () => {
    renderBar({ agentName: 'dorkbot' });
    const link = screen.getByRole('link', { name: 'Team' });
    expect(link).toHaveAttribute('href', '/team');
  });

  it('renders Session breadcrumb segment', () => {
    renderBar({ agentName: 'dorkbot' });
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toHaveTextContent('Session');
  });

  it('renders CommandPaletteTrigger', () => {
    renderBar({ agentName: 'dorkbot' });
    const triggers = screen.getAllByLabelText('Open command palette');
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });

  it('omits agent name when no agent', () => {
    renderBar({ agentName: undefined });
    expect(screen.queryByText('dorkbot')).not.toBeInTheDocument();
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toHaveTextContent('Session');
  });

  // --- Origin chip (session-origin-legibility) ---

  it('shows a muted origin chip for a non-user session', () => {
    renderBar({ agentName: 'dorkbot', origin: 'channel', originLabel: 'Telegram' });
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toHaveTextContent('Telegram');
  });

  it('falls back to the descriptor label when no originLabel is set', () => {
    renderBar({ agentName: 'dorkbot', origin: 'task' });
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toHaveTextContent('Scheduled task');
  });

  it('shows no origin chip for a user-origin session', () => {
    renderBar({ agentName: 'dorkbot', origin: 'user' });
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).not.toHaveTextContent('Telegram');
    expect(screen.queryByLabelText(/^Origin:/)).not.toBeInTheDocument();
  });

  it('shows no origin chip when origin is absent', () => {
    renderBar({ agentName: 'dorkbot' });
    expect(screen.queryByLabelText(/^Origin:/)).not.toBeInTheDocument();
  });
});
