// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Reply } from 'lucide-react';
import { TIMING } from '@/layers/shared/lib';
import { EntryActionMenu } from '../ui/EntryActionMenu';
import type { EntryAction } from '../lib/entry-actions';

/**
 * A touch screen. `useIsMobile` reads `matchMedia`, and it is what decides
 * whether this surface is a right-click menu or a bottom drawer — the drawer
 * being the only one of the two that carries a reaction row.
 */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
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

afterEach(cleanup);

const ACTIONS: EntryAction[] = [
  { id: 'reply', label: 'Reply in thread', icon: Reply, run: () => {} },
];

/** The surface as JSX, so a test can re-render it with the room gone quiet. */
function menuElement(disabled: boolean, onToggle: (emoji: string) => void) {
  return (
    <EntryActionMenu
      actions={ACTIONS}
      reactions={{ quick: ['👍', '❤️', '🎉'], mine: [], onToggle, disabled }}
    >
      <div data-testid="message">the deploy is stuck</div>
    </EntryActionMenu>
  );
}

function renderMenu(options: { disabled?: boolean; onToggle?: (emoji: string) => void } = {}) {
  return render(menuElement(options.disabled ?? false, options.onToggle ?? (() => {})));
}

/** Hold the message down long enough for the drawer, the way a finger does. */
function longPress() {
  vi.useFakeTimers();
  try {
    fireEvent.pointerDown(screen.getByTestId('message'), { button: 0, clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(TIMING.LONG_PRESS_MS + 50);
    });
  } finally {
    vi.useRealTimers();
  }
}

describe('EntryActionMenu — the touch drawer', () => {
  it('opens with a reaction row above the actions', () => {
    renderMenu();
    longPress();

    const row = screen.getByTestId('drawer-reactions');
    expect(row).toBeInTheDocument();
    expect(within(row).getAllByRole('button')).toHaveLength(4); // three quick, then 🙂+
    expect(screen.getByRole('button', { name: 'Reply in thread' })).toBeInTheDocument();
  });

  it('refuses every reaction control once the room has stopped listening', () => {
    // The drawer is the OTHER half of the §4 hole the reviewer of #639 found:
    // its quick row was gated but the picker it opens inline was not, so the
    // same stalled room refused a tap on 👍 and accepted one two taps later.
    const onToggle = vi.fn();
    renderMenu({ disabled: true, onToggle });
    longPress();

    const row = screen.getByTestId('drawer-reactions');
    for (const button of within(row).getAllByRole('button')) {
      expect(button).toBeDisabled();
    }

    fireEvent.click(within(row).getAllByRole('button')[0]!);
    expect(onToggle).not.toHaveBeenCalled();

    // The 🙂+ is one of those buttons, so the picker cannot even be reached from
    // a drawer opened on an already-quiet room.
    fireEvent.click(screen.getByRole('button', { name: 'Pick a reaction' }));
    expect(screen.queryByTestId('reaction-picker')).not.toBeInTheDocument();
  });

  it('opens its picker inline while the room is live', () => {
    // The control the next test is about, shown working — so a grid that were
    // disabled in every state could not pass that one by accident.
    renderMenu();
    longPress();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a reaction' }));

    const picker = screen.getByTestId('reaction-picker');
    expect(within(picker).getAllByRole('button')[0]).toBeEnabled();
  });

  it('carries a stall that lands while its picker is already open', () => {
    // The touch counterpart of the popover case, and the only reachable one
    // here: with the room already quiet the 🙂+ itself refuses (asserted above),
    // so the grid can only be caught open by the stall ARRIVING — the drawer
    // stays put, and the options under the reader's thumb have to go dead.
    const onToggle = vi.fn();
    const { rerender } = renderMenu({ onToggle });
    longPress();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a reaction' }));
    expect(within(screen.getByTestId('reaction-picker')).getAllByRole('button')[0]).toBeEnabled();

    rerender(menuElement(true, onToggle));

    const option = within(screen.getByTestId('reaction-picker')).getAllByRole('button')[0]!;
    expect(option).toBeDisabled();
    fireEvent.click(option);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
