/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// The import and agent-creation stores are the REAL ones: each dialog host
// opens on its store's `isOpen`, so a click is checked by which one opened.
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

import { useAgentCreationStore, useImportProjectsStore } from '@/layers/shared/model';
import { AgentGhostRows } from '../ui/AgentGhostRows';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  useImportProjectsStore.getState().close();
  useAgentCreationStore.getState().close();
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

    expect(useImportProjectsStore.getState().isOpen).toBe(true);
    expect(useAgentCreationStore.getState().isOpen).toBe(false);
  });

  it('on a hub, offers to create an agent instead of searching for projects', () => {
    hub.value = true;
    render(<AgentGhostRows />);

    expect(screen.queryByText('Bring in existing projects')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(useAgentCreationStore.getState()).toMatchObject({ isOpen: true, initialMode: 'new' });
    expect(useImportProjectsStore.getState().isOpen).toBe(false);
  });
});
