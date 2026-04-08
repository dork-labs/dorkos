/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDorkHubStore } from '../model/dork-hub-store';
import { DorkHubHeader } from '../ui/DorkHubHeader';

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
// Store reset helper
//
// DorkHubHeader reads from and writes to the real Zustand store. Snapshot the
// initial state once at module load and reset back to it before each test so
// tests do not pollute one another.
// ---------------------------------------------------------------------------

const INITIAL_STORE_STATE = useDorkHubStore.getState();

function resetStore() {
  useDorkHubStore.setState(INITIAL_STORE_STATE, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DorkHubHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    // Always restore real timers in case a test installed fake timers.
    vi.useRealTimers();
  });

  it('renders all five type filter tabs', () => {
    render(<DorkHubHeader />);

    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Plugins' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Skill Packs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Adapters' })).toBeInTheDocument();
  });

  it('renders the search input with an accessible label and the dork-hub-search test id', () => {
    render(<DorkHubHeader />);

    // The search input is labeled by a visually-hidden <Label htmlFor="dork-hub-search">.
    const searchInput = screen.getByLabelText('Search packages');
    expect(searchInput).toBeInTheDocument();
    expect(searchInput).toHaveAttribute('id', 'dork-hub-search');
    expect(screen.getByTestId('dork-hub-search')).toBe(searchInput);
  });

  it('marks the active type tab based on the store filter', () => {
    useDorkHubStore.getState().setTypeFilter('agent');
    render(<DorkHubHeader />);

    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('data-state', 'inactive');
  });

  it('clicking a type tab updates the store via setTypeFilter', async () => {
    const user = userEvent.setup();
    render(<DorkHubHeader />);

    expect(useDorkHubStore.getState().filters.type).toBe('all');

    await user.click(screen.getByRole('tab', { name: 'Plugins' }));

    expect(useDorkHubStore.getState().filters.type).toBe('plugin');
  });

  it('clicking the Skill Packs tab maps to the "skill-pack" filter value', async () => {
    const user = userEvent.setup();
    render(<DorkHubHeader />);

    await user.click(screen.getByRole('tab', { name: 'Skill Packs' }));

    expect(useDorkHubStore.getState().filters.type).toBe('skill-pack');
  });

  it('debounces search input by 300ms before committing to the store', () => {
    vi.useFakeTimers();
    render(<DorkHubHeader />);

    const searchInput = screen.getByTestId('dork-hub-search') as HTMLInputElement;

    // Local input updates immediately, but the store should not yet reflect it.
    // Use fireEvent (synchronous) so we don't need to mix userEvent's promises
    // with fake timers.
    fireEvent.change(searchInput, { target: { value: 'reviewer' } });
    expect(searchInput.value).toBe('reviewer');
    expect(useDorkHubStore.getState().filters.search).toBe('');

    // Advance just under the debounce window — store still unchanged.
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(useDorkHubStore.getState().filters.search).toBe('');

    // Cross the debounce threshold — store should now reflect the input.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useDorkHubStore.getState().filters.search).toBe('reviewer');
  });

  it('cancels a pending debounce when the user keeps typing', () => {
    vi.useFakeTimers();
    render(<DorkHubHeader />);

    const searchInput = screen.getByTestId('dork-hub-search') as HTMLInputElement;

    fireEvent.change(searchInput, { target: { value: 'rev' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Still well under the debounce window — keep typing.
    fireEvent.change(searchInput, { target: { value: 'reviewer' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Total elapsed = 400ms, but only 200ms since the last keystroke.
    expect(useDorkHubStore.getState().filters.search).toBe('');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    // 300ms since the last keystroke — store should now have the final value.
    expect(useDorkHubStore.getState().filters.search).toBe('reviewer');
  });
});
