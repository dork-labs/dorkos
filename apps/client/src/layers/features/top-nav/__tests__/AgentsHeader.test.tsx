// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentsHeader } from '../ui/AgentsHeader';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
let mockIsMobile = false;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockOpenCreateDialog = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useIsMobile: () => mockIsMobile,
  useAgentCreationStore: (selector: (s: { open: () => void }) => unknown) =>
    selector({ open: mockOpenCreateDialog }),
}));

vi.mock('../ui/CommandPaletteTrigger', () => ({
  CommandPaletteTrigger: () => (
    <button data-testid="command-palette-trigger" aria-label="Open command palette">
      Cmd
    </button>
  ),
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

afterEach(() => {
  cleanup();
  mockIsMobile = false;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentsHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "Agents" page title span', () => {
    render(<AgentsHeader viewMode="list" />);
    // The title is a <span> with class text-sm font-medium — query by its specific role/selector
    // to avoid collision with the "Agents" view-switcher tab button.
    expect(screen.getByText('Agents', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders New Agent button', () => {
    render(<AgentsHeader viewMode="list" />);
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
  });

  it('clicking New Agent calls useAgentCreationStore.open()', () => {
    render(<AgentsHeader viewMode="list" />);
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(mockOpenCreateDialog).toHaveBeenCalledTimes(1);
  });

  it('does not render a Search for Projects button', () => {
    render(<AgentsHeader viewMode="list" />);
    expect(screen.queryByRole('button', { name: /search for projects/i })).not.toBeInTheDocument();
  });

  it('renders CommandPaletteTrigger', () => {
    render(<AgentsHeader viewMode="list" />);
    expect(screen.getByTestId('command-palette-trigger')).toBeInTheDocument();
  });

  describe('view switcher (desktop)', () => {
    it('renders Agents and Topology tabs on desktop', () => {
      mockIsMobile = false;
      render(<AgentsHeader viewMode="list" />);
      expect(screen.getByRole('button', { name: 'Agents' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Topology' })).toBeInTheDocument();
    });

    it('renders Denied and Access tabs on desktop', () => {
      mockIsMobile = false;
      render(<AgentsHeader viewMode="list" />);
      expect(screen.getByRole('button', { name: 'Denied' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Access' })).toBeInTheDocument();
    });

    it('renders separator between primary and management groups', () => {
      mockIsMobile = false;
      render(<AgentsHeader viewMode="list" />);
      const separator = document.querySelector('.border-l');
      expect(separator).toBeInTheDocument();
    });

    it('applies active styling to the current view tab', () => {
      render(<AgentsHeader viewMode="topology" />);
      const topologyBtn = screen.getByRole('button', { name: 'Topology' });
      expect(topologyBtn).toHaveClass('bg-background');
      const agentsBtn = screen.getByRole('button', { name: 'Agents' });
      expect(agentsBtn).not.toHaveClass('bg-background');
    });

    it('applies active styling to denied tab when viewMode is denied', () => {
      render(<AgentsHeader viewMode="denied" />);
      const deniedBtn = screen.getByRole('button', { name: 'Denied' });
      expect(deniedBtn).toHaveClass('bg-background');
      const agentsBtn = screen.getByRole('button', { name: 'Agents' });
      expect(agentsBtn).not.toHaveClass('bg-background');
    });

    it('applies active styling to access tab when viewMode is access', () => {
      render(<AgentsHeader viewMode="access" />);
      const accessBtn = screen.getByRole('button', { name: 'Access' });
      expect(accessBtn).toHaveClass('bg-background');
      const agentsBtn = screen.getByRole('button', { name: 'Agents' });
      expect(agentsBtn).not.toHaveClass('bg-background');
    });

    it('calls navigate with topology view on Topology tab click', () => {
      render(<AgentsHeader viewMode="list" />);
      fireEvent.click(screen.getByRole('button', { name: 'Topology' }));
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/agents',
        search: expect.any(Function),
      });
      const searchFn = mockNavigate.mock.calls[0][0].search;
      expect(searchFn({ view: 'list', sort: 'name:asc' })).toEqual({
        view: 'topology',
        sort: 'name:asc',
      });
    });

    it('calls navigate with denied view on Denied tab click', () => {
      render(<AgentsHeader viewMode="list" />);
      fireEvent.click(screen.getByRole('button', { name: 'Denied' }));
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/agents',
        search: expect.any(Function),
      });
      const searchFn = mockNavigate.mock.calls[0][0].search;
      expect(searchFn({ view: 'list' })).toEqual({ view: 'denied' });
    });

    it('calls navigate with access view on Access tab click', () => {
      render(<AgentsHeader viewMode="list" />);
      fireEvent.click(screen.getByRole('button', { name: 'Access' }));
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/agents',
        search: expect.any(Function),
      });
      const searchFn = mockNavigate.mock.calls[0][0].search;
      expect(searchFn({ view: 'list' })).toEqual({ view: 'access' });
    });
  });

  describe('view switcher (mobile)', () => {
    it('renders Select dropdown on mobile instead of tab buttons', () => {
      mockIsMobile = true;
      render(<AgentsHeader viewMode="list" />);
      // Tab buttons should be hidden on mobile
      expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Topology' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Denied' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Access' })).not.toBeInTheDocument();
    });
  });
});
