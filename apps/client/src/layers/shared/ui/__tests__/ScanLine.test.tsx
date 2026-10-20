/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { setPrefersReducedMotion } from '@/test-setup';
import { ScanLine } from '../ScanLine';

afterEach(cleanup);

/** The layers drawn inside the root: glow, then beam, then the streaming highlight. */
function layers(container: HTMLElement): HTMLElement[] {
  const root = container.querySelector<HTMLElement>('[aria-hidden]');
  expect(root).not.toBeNull();
  return [...root!.children] as HTMLElement[];
}

describe('ScanLine', () => {
  it('draws the glow, the sweeping beam and the streaming highlight', () => {
    const { container } = render(<ScanLine color="#3b82f6" isTextStreaming />);
    expect(layers(container)).toHaveLength(3);
  });

  it('under reduced motion, draws only the static glow: no loop runs at all', () => {
    setPrefersReducedMotion(true);
    const { container } = render(<ScanLine color="#3b82f6" isTextStreaming />);
    const drawn = layers(container);
    expect(drawn).toHaveLength(1);
    // The glow is the one layer with no transform to animate.
    expect(drawn[0]!.style.filter).toBe('blur(3px)');
  });

  it('ends its beam in the off-white highlight, never pure white', () => {
    const { container } = render(<ScanLine color="#3b82f6" isTextStreaming />);
    const root = container.querySelector<HTMLElement>('[aria-hidden]')!;
    expect(root.className).toContain('[--scan-highlight:hsl(var(--background))]');
    expect(root.className).toContain('dark:[--scan-highlight:hsl(var(--foreground))]');
    for (const layer of layers(container)) {
      expect(layer.getAttribute('style') ?? '').not.toMatch(/\bwhite\b|#fff/i);
    }
  });
});
