import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useVisualViewportBottomInset } from '../use-visual-viewport-inset';

/**
 * A minimal stand-in for `window.visualViewport`: a real EventTarget carrying
 * settable `height`/`offsetTop`/`scale`, so tests can move the viewport and
 * dispatch the same `resize`/`scroll` events the browser fires. `scale` is
 * explicit (default 1 = unzoomed) because the hook treats `scale > 1` as an
 * unreliable reading.
 */
function makeFakeViewport(height: number, offsetTop = 0, scale = 1) {
  const target = new EventTarget();
  return Object.assign(target, { height, offsetTop, scale });
}

const ORIGINAL_INNER_HEIGHT = window.innerHeight;
const HAD_VV = Object.prototype.hasOwnProperty.call(window, 'visualViewport');
const ORIGINAL_VV_DESCRIPTOR = Object.getOwnPropertyDescriptor(window, 'visualViewport');

function setInnerHeight(value: number) {
  Object.defineProperty(window, 'innerHeight', { value, writable: true, configurable: true });
}

function setViewport(vv: ReturnType<typeof makeFakeViewport> | undefined) {
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
}

afterEach(() => {
  cleanup();
  setInnerHeight(ORIGINAL_INNER_HEIGHT);
  if (HAD_VV && ORIGINAL_VV_DESCRIPTOR) {
    Object.defineProperty(window, 'visualViewport', ORIGINAL_VV_DESCRIPTOR);
  } else {
    // jsdom has no visualViewport by default; delete our stub to restore that.
    delete (window as { visualViewport?: unknown }).visualViewport;
  }
});

describe('useVisualViewportBottomInset', () => {
  it('returns 0 when visualViewport is unavailable', () => {
    setViewport(undefined);
    const { result } = renderHook(() => useVisualViewportBottomInset());
    expect(result.current).toBe(0);
  });

  it('computes the inset from innerHeight, viewport height, and offsetTop at scale 1', () => {
    setInnerHeight(800);
    setViewport(makeFakeViewport(500, 40, 1)); // unzoomed: 800 - (500 + 40) = 260
    const { result } = renderHook(() => useVisualViewportBottomInset());
    expect(result.current).toBe(260);
  });

  it('returns 0 when pinch-zoomed, even with a shrunken viewport height', () => {
    setInnerHeight(800);
    // Zoom shrinks height just like a keyboard would — but scale > 1 marks the
    // reading unreliable, so the hook degrades to 0 instead of a phantom inset.
    setViewport(makeFakeViewport(400, 0, 2));
    const { result } = renderHook(() => useVisualViewportBottomInset());
    expect(result.current).toBe(0);
  });

  it('never returns a negative inset', () => {
    setInnerHeight(800);
    setViewport(makeFakeViewport(900, 0)); // 800 - 900 = -100 → clamped to 0
    const { result } = renderHook(() => useVisualViewportBottomInset());
    expect(result.current).toBe(0);
  });

  it('updates on the visual viewport resize event', () => {
    setInnerHeight(800);
    const vv = makeFakeViewport(800, 0);
    setViewport(vv);
    const { result } = renderHook(() => useVisualViewportBottomInset());
    expect(result.current).toBe(0);

    act(() => {
      vv.height = 500; // keyboard opens
      vv.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(300);
  });

  it('updates on the visual viewport scroll event', () => {
    setInnerHeight(800);
    const vv = makeFakeViewport(500, 0);
    setViewport(vv);
    const { result } = renderHook(() => useVisualViewportBottomInset());
    expect(result.current).toBe(300);

    act(() => {
      vv.offsetTop = 40; // scrolled the shrunken viewport
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(result.current).toBe(260);
  });

  it('removes both listeners on unmount', () => {
    const vv = makeFakeViewport(800, 0);
    setViewport(vv);
    const remove = vi.spyOn(vv, 'removeEventListener');
    const { unmount } = renderHook(() => useVisualViewportBottomInset());
    unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
