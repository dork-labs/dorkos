/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { Progress } from '../progress.js';
import { ScrollArea, ScrollBar } from '../scroll-area.js';
import { ScrollArea as RadixScrollArea } from 'radix-ui';

beforeEach(() => {
  // Radix measures scrollbar geometry; jsdom has no ResizeObserver.
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

describe('display and scroll controls', () => {
  // The fill and ARIA value must agree even for out-of-range callers.
  it('clamps progress visually and accessibly', () => {
    const { container } = render(<Progress value={140} aria-label="Upload" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ width: '100%' });
    expect(indicator).toHaveClass('motion-reduce:transition-none!');
  });

  // Callers use this ref for focus/scroll; forwarding only the root ref is insufficient.
  it('forwards ScrollArea viewport ref and preserves children', () => {
    const viewportRef = createRef<HTMLDivElement>();
    const { container } = render(
      <ScrollArea viewportRef={viewportRef} style={{ height: 80 }}>
        <div style={{ height: 200 }}>Long content</div>
      </ScrollArea>
    );
    expect(viewportRef.current).toBe(container.querySelector('[data-slot="scroll-area-viewport"]'));
    expect(viewportRef.current).toHaveTextContent('Long content');
    const onScroll = vi.fn();
    const viewport = viewportRef.current;
    if (!viewport) throw new Error('ScrollArea did not mount its viewport');
    viewport.addEventListener('scroll', onScroll);
    viewport.scrollTop = 36;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(36);
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it('keeps horizontal scrollbar orientation when rendered directly', () => {
    const { container } = render(
      <RadixScrollArea.Root type="always">
        <RadixScrollArea.Viewport>
          <div>Content</div>
        </RadixScrollArea.Viewport>
        <ScrollBar orientation="horizontal" forceMount />
      </RadixScrollArea.Root>
    );
    expect(container.querySelector('[data-slot="scroll-area-scrollbar"]')).toHaveAttribute(
      'data-orientation',
      'horizontal'
    );
  });
});
