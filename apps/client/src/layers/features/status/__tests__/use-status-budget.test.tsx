/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useStatusBudget } from '../model/use-status-budget';

// jsdom lays nothing out and reports every element as 0x0, so the observation has
// to be injectable: this stub captures the callback the hook registers and lets a
// test push a real width through it, exactly as a browser would after layout.
let emitWidth: ((width: number) => void) | null = null;

beforeEach(() => {
  emitWidth = null;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      emitWidth = (width: number) => {
        callback(
          [{ contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      };
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

/** Renders the resolved budget as data attributes so a test can read it. */
function Probe() {
  const { ref, budget } = useStatusBudget();
  return (
    <div
      ref={ref}
      data-testid="bar"
      data-density={budget.density}
      data-budget={String(budget.rightBudget)}
      data-dropped={budget.dropped.join(',')}
    />
  );
}

/** Push a measured width through the observer the hook registered. */
function resizeTo(width: number) {
  act(() => emitWidth?.(width));
}

describe('useStatusBudget', () => {
  it('starts unmeasured, so the first frame draws everything', () => {
    render(<Probe />);
    const bar = screen.getByTestId('bar');
    expect(bar).toHaveAttribute('data-density', 'full');
    expect(bar).toHaveAttribute('data-budget', 'Infinity');
  });

  it('clamps to the tier the observed width affords', () => {
    render(<Probe />);
    const bar = screen.getByTestId('bar');

    resizeTo(900);
    expect(bar).toHaveAttribute('data-density', 'full');
    expect(bar).toHaveAttribute('data-budget', '6');

    resizeTo(500);
    expect(bar).toHaveAttribute('data-density', 'compact');
    expect(bar).toHaveAttribute('data-budget', '4');
    expect(bar).toHaveAttribute('data-dropped', 'cwd');

    resizeTo(375);
    expect(bar).toHaveAttribute('data-density', 'identity');
    expect(bar).toHaveAttribute('data-budget', '3');
    expect(bar).toHaveAttribute('data-dropped', 'cwd,git');

    resizeTo(320);
    expect(bar).toHaveAttribute('data-density', 'avatar');
    expect(bar).toHaveAttribute('data-budget', '2');
  });

  it('widens again when the window or the sidebar gives the bar its space back', () => {
    render(<Probe />);
    const bar = screen.getByTestId('bar');
    resizeTo(320);
    expect(bar).toHaveAttribute('data-density', 'avatar');
    resizeTo(1200);
    expect(bar).toHaveAttribute('data-density', 'full');
    expect(bar).toHaveAttribute('data-dropped', '');
  });
});
