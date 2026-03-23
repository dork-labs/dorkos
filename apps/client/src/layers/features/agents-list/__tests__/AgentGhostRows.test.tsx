/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Suppress motion animation in tests
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

// Mock ResponsiveDialog and family — render children directly so dialog content is testable
vi.mock('@/layers/shared/ui/responsive-dialog', () => ({
  ResponsiveDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (open ? <div data-testid="responsive-dialog">{children}</div> : null),
  ResponsiveDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResponsiveDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResponsiveDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock DiscoveryView — not under test here
vi.mock('@/layers/features/mesh', () => ({
  DiscoveryView: () => <div data-testid="discovery-view">DiscoveryView</div>,
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
// Import component after mocks
// ---------------------------------------------------------------------------

import { AgentGhostRows } from '../ui/AgentGhostRows';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('AgentGhostRows', () => {
  it('renders 3 ghost rows with dashed border', () => {
    render(<AgentGhostRows />);

    const dashedRows = document.querySelectorAll('.border-dashed');
    expect(dashedRows).toHaveLength(3);
  });

  it('renders heading "Discover Your Agent Fleet"', () => {
    render(<AgentGhostRows />);

    expect(screen.getByText('Discover Your Agent Fleet')).toBeInTheDocument();
  });

  it('renders "Scan for Agents" button', () => {
    render(<AgentGhostRows />);

    expect(screen.getByRole('button', { name: /scan for agents/i })).toBeInTheDocument();
  });

  it('clicking "Scan for Agents" opens the discovery dialog', () => {
    render(<AgentGhostRows />);

    expect(screen.queryByTestId('responsive-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /scan for agents/i }));

    expect(screen.getByTestId('responsive-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('discovery-view')).toBeInTheDocument();
  });
});
