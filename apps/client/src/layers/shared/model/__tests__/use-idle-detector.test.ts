/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIdleDetector } from '../use-idle-detector';

describe('useIdleDetector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onIdle after timeout expires', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleDetector({ timeoutMs: 5000, onIdle }));
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('resets timer on mouse activity', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleDetector({ timeoutMs: 5000, onIdle }));
    vi.advanceTimersByTime(3000);
    act(() => { document.dispatchEvent(new Event('mousemove')); });
    vi.advanceTimersByTime(3000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('resets timer on keyboard activity', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleDetector({ timeoutMs: 5000, onIdle }));
    vi.advanceTimersByTime(4000);
    act(() => { document.dispatchEvent(new Event('keydown')); });
    vi.advanceTimersByTime(4000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('calls onReturn when user becomes active after idle', () => {
    const onIdle = vi.fn();
    const onReturn = vi.fn();
    renderHook(() => useIdleDetector({ timeoutMs: 5000, onIdle, onReturn }));
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledOnce();
    act(() => { document.dispatchEvent(new Event('mousemove')); });
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('marks idle on document hidden', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleDetector({ timeoutMs: 30000, onIdle }));
    Object.defineProperty(document, 'hidden', { value: true, writable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(onIdle).toHaveBeenCalledOnce();
    Object.defineProperty(document, 'hidden', { value: false, writable: true });
  });

  it('marks active when document becomes visible again', () => {
    const onIdle = vi.fn();
    const onReturn = vi.fn();
    renderHook(() => useIdleDetector({ timeoutMs: 30000, onIdle, onReturn }));
    Object.defineProperty(document, 'hidden', { value: true, writable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    Object.defineProperty(document, 'hidden', { value: false, writable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('does not call onIdle twice without return', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleDetector({ timeoutMs: 5000, onIdle }));
    vi.advanceTimersByTime(5000);
    Object.defineProperty(document, 'hidden', { value: true, writable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(onIdle).toHaveBeenCalledOnce();
    Object.defineProperty(document, 'hidden', { value: false, writable: true });
  });

  it('cleans up event listeners on unmount', () => {
    const spy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useIdleDetector({ timeoutMs: 5000 }));
    unmount();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
