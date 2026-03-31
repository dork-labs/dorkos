// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SessionHeader } from '../ui/SessionHeader';
import { TooltipProvider } from '@/layers/shared/ui';

// Mock app store (used by CommandPaletteTrigger and CanvasToggle)
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setGlobalPaletteOpen: vi.fn(),
      canvasOpen: false,
      canvasContent: null,
      setCanvasOpen: vi.fn(),
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

// Mock motion/react — CanvasToggle uses motion.button
function PassThrough({ children, ...rest }: Record<string, unknown>) {
  return (
    <div {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children as React.ReactNode}</div>
  );
}

vi.mock('motion/react', () => ({
  motion: new Proxy({} as Record<string, typeof PassThrough>, {
    get: () => PassThrough,
  }),
  AnimatePresence: PassThrough,
  useReducedMotion: () => true,
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

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('SessionHeader', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders agent name in breadcrumb', () => {
    renderWithTooltip(<SessionHeader agentName="dorkbot" />);
    expect(screen.getByText('dorkbot')).toBeInTheDocument();
  });

  it('renders Agents link pointing to /agents', () => {
    renderWithTooltip(<SessionHeader agentName="dorkbot" />);
    const link = screen.getByRole('link', { name: 'Agents' });
    expect(link).toHaveAttribute('href', '/agents');
  });

  it('renders Session breadcrumb segment', () => {
    renderWithTooltip(<SessionHeader agentName="dorkbot" />);
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toHaveTextContent('Session');
  });

  it('renders CommandPaletteTrigger', () => {
    renderWithTooltip(<SessionHeader agentName="dorkbot" />);
    const triggers = screen.getAllByLabelText('Open command palette');
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });

  it('renders CanvasToggle button', () => {
    renderWithTooltip(<SessionHeader agentName="dorkbot" />);
    const toggles = screen.getAllByLabelText('Open canvas');
    expect(toggles.length).toBeGreaterThanOrEqual(1);
  });

  it('omits agent name when no agent', () => {
    renderWithTooltip(<SessionHeader agentName={undefined} />);
    expect(screen.queryByText('dorkbot')).not.toBeInTheDocument();
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toHaveTextContent('Session');
  });
});
