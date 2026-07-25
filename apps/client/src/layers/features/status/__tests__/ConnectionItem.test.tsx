// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import { ConnectionItem } from '../ui/ConnectionItem';

afterEach(cleanup);

describe('ConnectionItem', () => {
  it('names the state in full at the widest tier', () => {
    render(<ConnectionItem connectionState="disconnected" />);
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
  });

  it('swaps in a shorter true sentence when the line narrows, never a truncated one', () => {
    // The slot budget counts slots, so every slot has to be about one size
    // (DOR-452). "Connection los…" would fit the bound and say nothing; "Offline"
    // fits and still answers the question.
    render(<ConnectionItem connectionState="disconnected" compact />);
    expect(screen.getByRole('status')).toHaveTextContent('Offline');
    expect(screen.getByRole('status')).not.toHaveTextContent('Connection lost');
  });

  it('leaves the live region unnamed so a screen reader reads the state once', () => {
    // `role="status"` announces its CONTENT; naming it would have a reader say the
    // long label and then the short one.
    render(<ConnectionItem connectionState="disconnected" compact />);
    expect(screen.getByRole('status')).not.toHaveAttribute('aria-label');
  });

  it('keeps every compact label within the bound the slot budget rests on', () => {
    for (const state of ['connecting', 'connected', 'reconnecting', 'disconnected'] as const) {
      const { unmount } = render(<ConnectionItem connectionState={state} compact />);
      const text = screen.getByRole('status').textContent ?? '';
      expect(Array.from(text.trim()).length).toBeLessThanOrEqual(STATUS_VALUE_MAX_CHARS);
      unmount();
    }
  });
});
