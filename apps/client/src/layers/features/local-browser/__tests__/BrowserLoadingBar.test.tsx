// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { BrowserLoadingBar } from '../ui/BrowserLoadingBar';

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => reduced.value,
}));

const bar = () => document.querySelector<HTMLElement>('[data-slot="browser-loading-bar"]');

beforeEach(() => {
  reduced.value = false;
});

describe('BrowserLoadingBar', () => {
  it('keeps its 2px seam whether or not anything loads, so the page never moves', () => {
    const view = render(<BrowserLoadingBar loading={false} />);
    const seam = document.querySelector('[data-slot="browser-loading-seam"]');
    expect(seam).toHaveClass('h-0.5');
    expect(seam).toHaveAttribute('aria-hidden');
    expect(bar()).toBeNull();
    view.rerender(<BrowserLoadingBar loading />);
    expect(bar()).not.toBeNull();
  });

  it('draws in the foreground at 35%, never a spinner', () => {
    render(<BrowserLoadingBar loading />);
    expect(bar()).toHaveClass('bg-foreground/35');
    expect(document.querySelector('svg, [role="progressbar"]')).toBeNull();
  });

  it('under reduced motion is a still line while loading, and gone straight after', () => {
    reduced.value = true;
    const view = render(<BrowserLoadingBar loading />);
    expect(bar()).not.toBeNull();
    expect(bar()?.style.transform ?? '').toBe('');
    view.rerender(<BrowserLoadingBar loading={false} />);
    expect(bar()).toBeNull();
  });
});
