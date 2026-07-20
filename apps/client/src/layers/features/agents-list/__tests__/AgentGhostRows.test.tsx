/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
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

const mockImportOpen = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useImportProjectsStore: (selector?: (s: { open: () => void }) => unknown) => {
    const state = { open: mockImportOpen };
    return selector ? selector(state) : state;
  },
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

beforeEach(() => {
  mockImportOpen.mockReset();
});

afterEach(cleanup);

describe('AgentGhostRows', () => {
  it('renders 3 ghost rows with dashed border', () => {
    render(<AgentGhostRows />);

    const dashedRows = document.querySelectorAll('.border-dashed');
    expect(dashedRows).toHaveLength(3);
  });

  it('renders the unified import heading', () => {
    render(<AgentGhostRows />);

    expect(screen.getByText('Bring in existing projects')).toBeInTheDocument();
  });

  it('renders "Search for Projects" button', () => {
    render(<AgentGhostRows />);

    expect(screen.getByRole('button', { name: /search for projects/i })).toBeInTheDocument();
  });

  it('clicking "Search for Projects" opens the standalone import dialog', () => {
    render(<AgentGhostRows />);

    fireEvent.click(screen.getByRole('button', { name: /search for projects/i }));

    expect(mockImportOpen).toHaveBeenCalledTimes(1);
  });
});
