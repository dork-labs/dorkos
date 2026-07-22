// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

  it('no longer renders a "New conversation" button (the composer supersedes it)', () => {
    renderWithTooltip(<DashboardHeader />);
    expect(screen.queryByRole('button', { name: /new conversation/i })).not.toBeInTheDocument();
  });

  it('does not render other quick-action buttons', () => {
    renderWithTooltip(<DashboardHeader />);
    expect(screen.queryByRole('button', { name: /schedule/i })).not.toBeInTheDocument();
  });
});
