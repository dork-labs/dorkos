import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TitlebarDragStrip } from '../TitlebarDragStrip';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('desktop-darwin');
});

describe('TitlebarDragStrip', () => {
  it('renders hidden by default (browser and Obsidian)', () => {
    const { container } = render(<TitlebarDragStrip />);
    const strip = container.firstElementChild;

    expect(strip).toHaveClass('hidden');
    expect(strip).not.toHaveClass('block');
  });

  it('carries the desktop-darwin reveal, height, and drag-region classes when the desktop shell class is present', () => {
    document.documentElement.classList.add('desktop-darwin');
    const { container } = render(<TitlebarDragStrip />);
    const strip = container.firstElementChild;

    // jsdom doesn't evaluate Tailwind's compiled CSS, so this asserts the
    // element carries the variant classes that reveal it under
    // `.desktop-darwin` rather than the resulting computed style.
    expect(strip).toHaveClass('desktop-darwin:block');
    expect(strip).toHaveClass('desktop-darwin:h-11');
    expect(strip).toHaveClass('desktop-darwin:drag-region');
  });

  it('is aria-hidden — decorative only, never a tab stop', () => {
    const { container } = render(<TitlebarDragStrip />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
