// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DashboardHeader } from '../ui/DashboardHeader';
import { TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSetGlobalPaletteOpen = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
    };
    return selector ? selector(state) : state;
  },
  useNow: () => Date.now(),
}));

const mockStartSession = vi.fn();
vi.mock('@/layers/entities/config', () => ({
  useDefaultAgentSession: () => ({
    startSession: mockStartSession,
    defaultAgentDir: '~/.dork/agents/dorkbot',
  }),
}));

vi.mock('@/layers/entities/tasks', () => ({
  useTaskRuns: () => ({ data: undefined }),
  useTasksEnabled: () => false,
}));

vi.mock('@/layers/entities/relay', () => ({
  useAggregatedDeadLetters: () => ({ data: undefined }),
  useRelayAdapters: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshStatus: () => ({ data: undefined }),
}));

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

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders "Dashboard" text', () => {
    renderWithTooltip(<DashboardHeader />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('renders CommandPaletteTrigger', () => {
    renderWithTooltip(<DashboardHeader />);
    const triggers = screen.getAllByLabelText('Open command palette');
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });

  it('renders system health dot', () => {
    const { container } = renderWithTooltip(<DashboardHeader />);
    const dots = container.querySelectorAll('span.rounded-full');
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });

  it('renders a "New conversation" button that starts a session with the default agent', () => {
    renderWithTooltip(<DashboardHeader />);
    const button = screen.getByRole('button', { name: /new conversation/i });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(mockStartSession).toHaveBeenCalledTimes(1);
  });

  it('does not render other quick-action buttons', () => {
    renderWithTooltip(<DashboardHeader />);
    expect(screen.queryByRole('button', { name: /schedule/i })).not.toBeInTheDocument();
  });
});
