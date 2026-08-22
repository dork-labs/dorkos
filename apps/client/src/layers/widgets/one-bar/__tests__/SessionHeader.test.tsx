// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { OneBarRouteState } from '../model/one-bar-context';
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

const VISUAL = { color: 'hsl(210 70% 55%)', emoji: '🤖' };

function renderBar(state: Partial<OneBarRouteState>) {
  return render(
    <BarHarness {...state}>
      <SessionHeader />
    </BarHarness>
  );
}

/** The identity zone's title element — the one that carries the session's name. */
function titleElement(text: string) {
  return screen.getByTitle(text);
}

describe('SessionHeader', () => {
  afterEach(() => {
    cleanup();
  });

  // --- Identity (D1): face · name · › · title ---

  it('shows the agent name and the session title', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'Fix the flaky test' });
    expect(screen.getByText('dorkbot')).toBeInTheDocument();
    expect(screen.getByText('Fix the flaky test')).toBeInTheDocument();
  });

  it("draws the agent's face from its resolved visual", () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'Fix the flaky test' });
    expect(screen.getByText(VISUAL.emoji)).toBeInTheDocument();
    expect(screen.queryByTestId('session-directory-mark')).not.toBeInTheDocument();
  });

  it('drops the breadcrumb it replaced', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'Fix the flaky test' });
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
    expect(screen.queryByText('Session')).not.toBeInTheDocument();
  });

  // --- Fallbacks (spec §5.3) ---

  it('names a session the runtime has not titled yet "New session"', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: '' });
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('says "New session" before any title has been fetched at all', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL });
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('falls back to the directory name when the session has no agent', () => {
    renderBar({ sessionDirectoryName: 'dork-os', sessionTitle: 'Read the notes' });
    expect(screen.getByText('dork-os')).toBeInTheDocument();
  });

  it('draws a generic mark rather than an empty face when there is no agent', () => {
    renderBar({ sessionDirectoryName: 'dork-os' });
    expect(screen.queryByText(VISUAL.emoji)).not.toBeInTheDocument();
    // The identity still opens with a mark — a name with nothing beside it is
    // the empty-avatar hole this fallback exists to close.
    expect(screen.getByTestId('session-directory-mark')).toBeInTheDocument();
  });

  it('shows a live title beside the directory name, not the agent name it lacks', () => {
    renderBar({ sessionDirectoryName: 'dork-os', sessionTitle: 'Read the notes' });
    expect(screen.getByText('Read the notes')).toBeInTheDocument();
  });

  // --- Truncation (I2): the title yields before the name does ---

  it('lets the title truncate and holds the name at its width', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'A very long title' });
    expect(titleElement('A very long title')).toHaveClass('truncate', 'min-w-0');
    expect(titleElement('dorkbot')).toHaveClass('shrink-0');
  });

  it('keeps the full title reachable on hover when it is cut off', () => {
    const long = 'A title long enough that no bar in the product could show all of it at once';
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: long });
    expect(titleElement(long)).toHaveTextContent(long);
  });

  // --- Origin chip (session-origin-legibility) ---

  it('shows a muted origin chip for a non-user session', () => {
    renderBar({
      agentName: 'dorkbot',
      agentVisual: VISUAL,
      origin: 'channel',
      originLabel: 'Telegram',
    });
    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });

  it('falls back to the descriptor label when no originLabel is set', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, origin: 'task' });
    expect(screen.getByText('Scheduled task')).toBeInTheDocument();
  });

  it('shows no origin chip for a user-origin session', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, origin: 'user' });
    expect(screen.queryByLabelText(/^Origin:/)).not.toBeInTheDocument();
  });

  it('shows no origin chip when origin is absent', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL });
    expect(screen.queryByLabelText(/^Origin:/)).not.toBeInTheDocument();
  });
});
