/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockImportOpen = vi.fn();
const mockCreateOpen = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useImportProjectsStore: (selector?: (s: { open: () => void }) => unknown) => {
    const state = { open: mockImportOpen };
    return selector ? selector(state) : state;
  },
  useAgentCreationStore: (selector?: (s: { open: () => void }) => unknown) => {
    const state = { open: mockCreateOpen };
    return selector ? selector(state) : state;
  },
}));
const hub = vi.hoisted(() => ({ value: false }));
vi.mock('@/layers/entities/config', () => ({ useIsHub: () => hub.value }));

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
  mockCreateOpen.mockReset();
  hub.value = false;
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

  it('renders "Search for projects" button', () => {
    render(<AgentGhostRows />);

    expect(screen.getByRole('button', { name: /search for projects/i })).toBeInTheDocument();
  });

  it('clicking "Search for projects" opens the standalone import dialog', () => {
    render(<AgentGhostRows />);

    fireEvent.click(screen.getByRole('button', { name: /search for projects/i }));

    expect(mockImportOpen).toHaveBeenCalledTimes(1);
  });

  it('on a hub, offers to create an agent instead of searching for projects', () => {
    hub.value = true;
    render(<AgentGhostRows />);

    expect(screen.queryByText('Bring in existing projects')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(mockCreateOpen).toHaveBeenCalledTimes(1);
    expect(mockImportOpen).not.toHaveBeenCalled();
  });
});
