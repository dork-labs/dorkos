// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import { ConnectionItem } from '../ui/ConnectionItem';

afterEach(cleanup);

/** The item's own box. It carries no role of its own — see the naming test below. */
function readout(): HTMLElement {
  return screen.getByText(/Live stream lost|Offline|Connecting|Reconnecting|Connected/);
}

describe('ConnectionItem', () => {
  it('names the state in full at the widest tier', () => {
    render(<ConnectionItem connectionState="disconnected" />);
    expect(readout()).toHaveTextContent('Live stream lost');
  });

  it('swaps in a shorter true sentence when the line narrows, never a truncated one', () => {
    // The slot budget counts slots, so every slot has to be about one size
    // (DOR-452). "Live stream lo…" would fit the bound and say nothing; "Offline"
    // fits and still answers the question.
    render(<ConnectionItem connectionState="disconnected" compact />);
    expect(readout()).toHaveTextContent('Offline');
    expect(readout()).not.toHaveTextContent('Live stream lost');
  });

  it('adds no live region of its own, and no name that would double up', () => {
    // The row is already `aria-live="polite"` (see `StatusLine`), so a `role=status`
    // here would be a live region inside a live region and could announce the same
    // change twice (DOR-461 review). An `aria-label` would be its own version of
    // the same fault: a reader would say the long label and then the short one it
    // replaces. The hover card carries the full sentence.
    render(<ConnectionItem connectionState="disconnected" compact />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(readout().closest('span')).not.toHaveAttribute('aria-label');
  });

  it('keeps every compact label within the bound the slot budget rests on', () => {
    for (const state of ['connecting', 'connected', 'reconnecting', 'disconnected'] as const) {
      const { unmount } = render(<ConnectionItem connectionState={state} compact />);
      const text = readout().textContent ?? '';
      expect(Array.from(text.trim()).length).toBeLessThanOrEqual(STATUS_VALUE_MAX_CHARS);
      unmount();
    }
  });
});
