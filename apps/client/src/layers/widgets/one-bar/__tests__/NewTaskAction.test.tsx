// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NewTaskAction } from '../ui/NewTaskAction';
import { BarHarness } from './bar-harness';

// The fixed cluster OneBar renders. Both are real widgets with their own data
// needs; this suite is about what the BAR says, so they are stubbed at the seam.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockIsMobile = false;

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setGlobalPaletteOpen: vi.fn() };
    return selector ? selector(state) : state;
  },
  useIsMobile: () => mockIsMobile,
}));

const mockOpenBlank = vi.fn();
vi.mock('@/layers/entities/tasks', () => ({
  useTasksEnabled: () => true,
  useTaskTemplateDialog: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openBlank: mockOpenBlank };
    return selector ? selector(state) : state;
  },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  mockIsMobile = false;
});

/** Mount the action inside the bar it ships in. */
function renderAction() {
  render(
    <BarHarness>
      <NewTaskAction />
    </BarHarness>
  );
}

describe('NewTaskAction', () => {
  // The page's NAME is the tab now — "Scheduled" is drawn by the shared
  // home-surface strip, and `HomeSurfaceBar.test.tsx` pins that it says so on
  // this route. What is left here is what Scheduled adds to that bar.

  it('still calls the thing you create a task', () => {
    // Renaming the page did not rename the noun: task creation keeps its own
    // vocabulary, here and in the dialogs.
    renderAction();

    expect(screen.getByRole('button', { name: /new schedule/i })).toBeInTheDocument();
  });

  it('collapses to a labelled icon on a phone (DOR-1747)', () => {
    // The words were the last thing in a 390px bar still spending width the row
    // did not have, and the actions cluster is `shrink-0` — so it painted 11px
    // past the bar's own wrapper instead of yielding. The button stays reachable
    // by the same name; only the letters go.
    mockIsMobile = true;
    renderAction();

    const button = screen.getByRole('button', { name: 'New Schedule' });
    expect(button).not.toHaveTextContent('New Schedule');
  });

  it('spells the words out on a desktop', () => {
    renderAction();

    expect(screen.getByRole('button', { name: /new schedule/i })).toHaveTextContent('New Schedule');
  });
});
