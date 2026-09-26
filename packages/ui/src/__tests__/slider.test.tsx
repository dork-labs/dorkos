/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Slider } from '../slider.js';

beforeEach(() => {
  // Radix measures thumbs; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Slider', () => {
  // Each controlled value needs its own thumb, including a two-ended range.
  it('renders one thumb per value and preserves the controlled values', () => {
    const { container } = render(<Slider aria-label="Range" value={[20, 80]} />);
    expect(container.querySelectorAll('[data-slot="slider-thumb"]')).toHaveLength(2);
    expect(screen.getAllByRole('slider').map((node) => node.getAttribute('aria-valuenow'))).toEqual(
      ['20', '80']
    );
  });

  // Radix keyboard changes are part of the caller-facing value contract.
  it('reports arrow-key changes for an uncontrolled thumb', () => {
    const changed = vi.fn();
    render(<Slider aria-label="Level" defaultValue={[20]} onValueChange={changed} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(changed).toHaveBeenCalled();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '21');
  });
});
