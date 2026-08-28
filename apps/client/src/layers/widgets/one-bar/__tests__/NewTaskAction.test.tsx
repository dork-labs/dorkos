// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
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

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setGlobalPaletteOpen: vi.fn() };
    return selector ? selector(state) : state;
  },
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

describe('NewTaskAction', () => {
  // The page's NAME is the tab now — "Scheduled" is drawn by the shared
  // home-surface strip, and `HomeSurfaceBar.test.tsx` pins that it says so on
  // this route. What is left here is what Scheduled adds to that bar.

  it('still calls the thing you create a task', () => {
    // Renaming the page did not rename the noun: task creation keeps its own
    // vocabulary, here and in the dialogs.
    render(
      <BarHarness>
        <NewTaskAction />
      </BarHarness>
    );

    expect(screen.getByRole('button', { name: /new schedule/i })).toBeInTheDocument();
  });
});
