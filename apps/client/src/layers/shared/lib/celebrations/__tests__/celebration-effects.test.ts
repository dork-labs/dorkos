/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock canvas-confetti before importing the engine.
vi.mock('canvas-confetti', () => {
  const mockConfetti = vi.fn();
  (mockConfetti as unknown as { reset: () => void }).reset = vi.fn();
  (mockConfetti as unknown as { shapeFromText: (o: unknown) => unknown }).shapeFromText = vi.fn(
    (o) => ({ shape: 'text', from: o })
  );
  return { default: mockConfetti };
});

import { fireCelebration, rectToCelebrationOrigin } from '../celebration-effects';

const getConfetti = async () =>
  (await import('canvas-confetti')).default as unknown as ReturnType<typeof vi.fn> & {
    reset: ReturnType<typeof vi.fn>;
    shapeFromText: ReturnType<typeof vi.fn>;
  };

/** Force a matchMedia result for prefers-reduced-motion. */
function mockReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes('reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('rectToCelebrationOrigin', () => {
  it('maps a rect to its normalized viewport center', () => {
    const origin = rectToCelebrationOrigin(
      { left: 100, top: 200, width: 40, height: 20 },
      { width: 1000, height: 1000 }
    );
    // center = (120, 210) → (0.12, 0.21)
    expect(origin.x).toBeCloseTo(0.12);
    expect(origin.y).toBeCloseTo(0.21);
  });

  it('clamps out-of-viewport rects into 0–1', () => {
    const origin = rectToCelebrationOrigin(
      { left: -50, top: 2000, width: 10, height: 10 },
      { width: 1000, height: 1000 }
    );
    expect(origin.x).toBe(0);
    expect(origin.y).toBe(1);
  });
});

describe('fireCelebration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReducedMotion(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a multi-stage burst from the given origin by default', async () => {
    const confetti = await getConfetti();
    await fireCelebration({ origin: { x: 0.2, y: 0.3 } });
    // Burst fires at least two synchronous stages.
    expect(confetti.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [opts] of confetti.mock.calls) {
      expect(opts.origin).toEqual({ x: 0.2, y: 0.3 });
      expect(opts.disableForReducedMotion).toBe(true);
    }
  });

  it('is a no-op under prefers-reduced-motion (never loads or fires)', async () => {
    mockReducedMotion(true);
    const confetti = await getConfetti();
    const cleanup = await fireCelebration({ kind: 'fireworks' });
    expect(confetti).not.toHaveBeenCalled();
    // Cleanup is safe to call.
    expect(() => cleanup()).not.toThrow();
  });

  it('emoji kind derives a shape from the supplied glyph', async () => {
    const confetti = await getConfetti();
    await fireCelebration({ kind: 'emoji', emoji: '🏆', origin: { x: 0.5, y: 0.5 } });
    expect(confetti.shapeFromText).toHaveBeenCalledWith(expect.objectContaining({ text: '🏆' }));
  });

  it('emoji kind defaults the glyph to 🎉', async () => {
    const confetti = await getConfetti();
    await fireCelebration({ kind: 'emoji' });
    expect(confetti.shapeFromText).toHaveBeenCalledWith(expect.objectContaining({ text: '🎉' }));
  });

  it('cleanup cancels pending echoes and resets the canvas', async () => {
    vi.useFakeTimers();
    const confetti = await getConfetti();
    const cleanup = await fireCelebration({ kind: 'burst' });
    const afterSyncCalls = confetti.mock.calls.length;
    cleanup();
    // Advance past the echo delay — the cancelled timeout must not fire again.
    vi.advanceTimersByTime(500);
    expect(confetti.mock.calls.length).toBe(afterSyncCalls);
    expect(confetti.reset).toHaveBeenCalled();
  });

  it('ambient kinds fire on an interval and stop when cleaned up', async () => {
    vi.useFakeTimers();
    const confetti = await getConfetti();
    const cleanup = await fireCelebration({ kind: 'fireworks' });
    vi.advanceTimersByTime(600);
    const midCalls = confetti.mock.calls.length;
    expect(midCalls).toBeGreaterThan(0);
    cleanup();
    vi.advanceTimersByTime(3000);
    // No further shells after cleanup.
    expect(confetti.mock.calls.length).toBe(midCalls);
  });
});
