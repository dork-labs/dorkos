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

vi.mock('@/layers/shared/model', () => ({
  useIsMobile: () => mockIsMobile,
}));

vi.mock('@/layers/features/mesh', () => ({
  DiscoveryView: () => <div data-testid="discovery-view">DiscoveryView</div>,
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

  it('renders Scan for Agents button', () => {
    render(<AgentsHeader viewMode="list" />);
    expect(screen.getByRole('button', { name: /scan for agents/i })).toBeInTheDocument();
  });

  it('opens discovery dialog on Scan button click', () => {
    render(<AgentsHeader viewMode="list" />);

    // Discovery view not visible initially
    expect(screen.queryByTestId('discovery-view')).not.toBeInTheDocument();

    // Click the scan button
    fireEvent.click(screen.getByRole('button', { name: /scan for agents/i }));

    // Discovery view should now be visible in dialog
    expect(screen.getByTestId('discovery-view')).toBeInTheDocument();
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

    it('hides view switcher on mobile', () => {
      mockIsMobile = true;
      render(<AgentsHeader viewMode="list" />);
      expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Topology' })).not.toBeInTheDocument();
    });

    it('applies active styling to the current view tab', () => {
      render(<AgentsHeader viewMode="topology" />);
      const topologyBtn = screen.getByRole('button', { name: 'Topology' });
      expect(topologyBtn).toHaveClass('bg-background');
      const agentsBtn = screen.getByRole('button', { name: 'Agents' });
      expect(agentsBtn).not.toHaveClass('bg-background');
    });

    it('calls navigate with correct view param on tab click', () => {
      render(<AgentsHeader viewMode="list" />);
      fireEvent.click(screen.getByRole('button', { name: 'Topology' }));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents', search: { view: 'topology' } });
    });
  });
});
