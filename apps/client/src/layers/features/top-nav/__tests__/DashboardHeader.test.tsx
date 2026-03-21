// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardHeader } from '../ui/DashboardHeader';
import { TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockSetPulseOpen = vi.fn();
const mockSetGlobalPaletteOpen = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
      setPulseOpen: mockSetPulseOpen,
    };
    return selector ? selector(state) : state;
  },
}));

const mockUsePulseEnabled = vi.fn<() => boolean>(() => false);
vi.mock('@/layers/entities/pulse', () => ({
  useRuns: () => ({ data: undefined }),
  usePulseEnabled: () => mockUsePulseEnabled(),
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
    mockUsePulseEnabled.mockReturnValue(false);
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
    // Health dot is a span with rounded-full class
    const dots = container.querySelectorAll('span.rounded-full');
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });

  it('renders "New session" button', () => {
    const { container } = renderWithTooltip(<DashboardHeader />);
    const btn = container.querySelector('button.h-6');
    expect(btn?.textContent).toMatch(/new session/i);
  });

  it('"New session" button navigates to /session', () => {
    renderWithTooltip(<DashboardHeader />);
    const buttons = screen.getAllByRole('button', { name: /new session/i });
    fireEvent.click(buttons[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/session' });
  });

  it('does not render "Schedule" button when Pulse is disabled', () => {
    mockUsePulseEnabled.mockReturnValue(false);
    renderWithTooltip(<DashboardHeader />);
    expect(screen.queryByRole('button', { name: /schedule/i })).not.toBeInTheDocument();
  });

  it('renders "Schedule" button when Pulse is enabled', () => {
    mockUsePulseEnabled.mockReturnValue(true);
    renderWithTooltip(<DashboardHeader />);
    expect(screen.getByRole('button', { name: /schedule/i })).toBeInTheDocument();
  });

  it('"Schedule" button opens Pulse panel', () => {
    mockUsePulseEnabled.mockReturnValue(true);
    renderWithTooltip(<DashboardHeader />);
    const buttons = screen.getAllByRole('button', { name: /schedule/i });
    fireEvent.click(buttons[0]);
    expect(mockSetPulseOpen).toHaveBeenCalledWith(true);
  });
});
