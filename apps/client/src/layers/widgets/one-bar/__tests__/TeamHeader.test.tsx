// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TeamHeader } from '../ui/TeamHeader';
import { BarHarness } from './bar-harness';

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

vi.mock('@/layers/features/top-nav', () => ({
  CommandPaletteTrigger: () => (
    <button data-testid="command-palette-trigger" aria-label="Open command palette">
      Cmd
    </button>
  ),
}));
// The fixed cluster OneBar renders. Both are real widgets with their own data
// needs; this suite is about what the BAR says, so they are stubbed at the seam.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Radix's Select content calls these on mount. jsdom implements no layout,
  // so it ships neither — without them the dropdown throws before its items
  // are queryable, and the mobile assertion below could never run.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

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

describe('TeamHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('titles the page Team', () => {
    render(
      <BarHarness teamViewMode="cards">
        <TeamHeader />
      </BarHarness>
    );
    // A <span>, queried as one so it does not collide with a view-switch tab
    // that happens to share a word.
    expect(screen.getByText('Team', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders New Agent button', () => {
    render(
      <BarHarness teamViewMode="cards">
        <TeamHeader />
      </BarHarness>
    );
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
  });

  it('clicking New Agent calls useAgentCreationStore.open()', () => {
    render(
      <BarHarness teamViewMode="cards">
        <TeamHeader />
      </BarHarness>
    );
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(mockOpenCreateDialog).toHaveBeenCalledTimes(1);
  });

  it('renders CommandPaletteTrigger', () => {
    render(
      <BarHarness teamViewMode="cards">
        <TeamHeader />
      </BarHarness>
    );
    expect(screen.getByTestId('command-palette-trigger')).toBeInTheDocument();
  });

  describe('view switcher (desktop)', () => {
    it('offers every view, the table included', () => {
      mockIsMobile = false;
      render(
        <BarHarness teamViewMode="cards">
          <TeamHeader />
        </BarHarness>
      );
      for (const label of ['Cards', 'Table', 'Topology', 'Denied', 'Access']) {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
      }
    });

    it('renders separator between primary and management groups', () => {
      mockIsMobile = false;
      render(
        <BarHarness teamViewMode="cards">
          <TeamHeader />
        </BarHarness>
      );
      expect(document.querySelector('.border-l')).not.toBeNull();
    });

    it('applies active styling to the current view tab', () => {
      render(
        <BarHarness teamViewMode="topology">
          <TeamHeader />
        </BarHarness>
      );
      expect(screen.getByRole('button', { name: 'Topology' })).toHaveClass('bg-background');
      expect(screen.getByRole('button', { name: 'Cards' })).not.toHaveClass('bg-background');
    });

    it('applies active styling to the table tab', () => {
      render(
        <BarHarness teamViewMode="table">
          <TeamHeader />
        </BarHarness>
      );
      expect(screen.getByRole('button', { name: 'Table' })).toHaveClass('bg-background');
      expect(screen.getByRole('button', { name: 'Cards' })).not.toHaveClass('bg-background');
    });

    it('applies active styling to denied tab when viewMode is denied', () => {
      render(
        <BarHarness teamViewMode="denied">
          <TeamHeader />
        </BarHarness>
      );
      expect(screen.getByRole('button', { name: 'Denied' })).toHaveClass('bg-background');
      expect(screen.getByRole('button', { name: 'Cards' })).not.toHaveClass('bg-background');
    });

    it('applies active styling to access tab when viewMode is access', () => {
      render(
        <BarHarness teamViewMode="access">
          <TeamHeader />
        </BarHarness>
      );
      expect(screen.getByRole('button', { name: 'Access' })).toHaveClass('bg-background');
      expect(screen.getByRole('button', { name: 'Cards' })).not.toHaveClass('bg-background');
    });

    it('navigates to /team, keeping the rest of the search params', () => {
      render(
        <BarHarness teamViewMode="cards">
          <TeamHeader />
        </BarHarness>
      );
      fireEvent.click(screen.getByRole('button', { name: 'Topology' }));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/team', search: expect.any(Function) });
      const searchFn = mockNavigate.mock.calls[0][0].search;
      // The owner filter survives a view change: the same people are still the
      // subject, drawn a different way.
      expect(searchFn({ view: 'cards', owner: 'person-1', sort: 'name:asc' })).toEqual({
        view: 'topology',
        owner: 'person-1',
        sort: 'name:asc',
      });
    });

    it('reaches the table view', () => {
      render(
        <BarHarness teamViewMode="cards">
          <TeamHeader />
        </BarHarness>
      );
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      const searchFn = mockNavigate.mock.calls[0][0].search;
      expect(searchFn({ view: 'cards' })).toEqual({ view: 'table' });
    });
  });

  describe('view switcher (mobile)', () => {
    it('replaces the tab buttons with a Select', () => {
      mockIsMobile = true;
      render(
        <BarHarness teamViewMode="cards">
          <TeamHeader />
        </BarHarness>
      );
      for (const label of ['Cards', 'Table', 'Topology', 'Denied', 'Access']) {
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
      }
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('does not offer the table below md', async () => {
      mockIsMobile = true;
      render(
        <BarHarness teamViewMode="cards">
          <TeamHeader />
        </BarHarness>
      );

      // Open the Select so its items mount — Radix renders them lazily, so an
      // assertion against the closed trigger would pass no matter what the
      // option list holds.
      fireEvent.click(screen.getByRole('combobox'));
      expect(await screen.findByRole('option', { name: 'Cards' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Topology' })).toBeInTheDocument();
      // The one that is deliberately absent: six columns at 375px is a scroll
      // bar wearing a table.
      expect(screen.queryByRole('option', { name: 'Table' })).not.toBeInTheDocument();
    });

    it('still names the table when that is where you already are', () => {
      // `/agents?view=list` redirects to `?view=table`, so a phone reaches this
      // view in one hop. A Select whose value matches no item renders blank —
      // the switch would go silent about where you are.
      mockIsMobile = true;
      render(
        <BarHarness teamViewMode="table">
          <TeamHeader />
        </BarHarness>
      );

      expect(screen.getByRole('combobox')).toHaveTextContent('Table');
    });

    it('offers a way off the table once you are on it', async () => {
      mockIsMobile = true;
      render(
        <BarHarness teamViewMode="table">
          <TeamHeader />
        </BarHarness>
      );

      fireEvent.click(screen.getByRole('combobox'));
      expect(await screen.findByRole('option', { name: 'Table' })).toBeInTheDocument();
      // The point of keeping it listed is being able to leave.
      expect(screen.getByRole('option', { name: 'Cards' })).toBeInTheDocument();
    });
  });
});
