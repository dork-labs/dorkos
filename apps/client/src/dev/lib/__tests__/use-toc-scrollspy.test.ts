/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTocScrollspy } from '../use-toc-scrollspy';

type IntersectionCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;

let observerCallback: IntersectionCallback;
let observedElements: Element[] = [];
let disconnectSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  observedElements = [];
  disconnectSpy = vi.fn();

  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionCallback) {
        observerCallback = callback;
      }
      observe(el: Element) {
        observedElements.push(el);
      }
      unobserve() {}
      disconnect() {
        disconnectSpy();
      }
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTocScrollspy', () => {
  it('returns null when no sections are intersecting', () => {
    const ids = ['section-a', 'section-b'];
    for (const id of ids) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }

    const { result } = renderHook(() => useTocScrollspy(ids));
    expect(result.current).toBeNull();

    for (const id of ids) document.getElementById(id)?.remove();
  });

  it('returns the first intersecting section ID in document order', () => {
    const ids = ['section-a', 'section-b', 'section-c'];
    for (const id of ids) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }

    const { result } = renderHook(() => useTocScrollspy(ids));

    act(() => {
      observerCallback([
        { target: document.getElementById('section-b')!, isIntersecting: true },
        { target: document.getElementById('section-c')!, isIntersecting: true },
      ]);
    });

    // section-b comes first in document order
    expect(result.current).toBe('section-b');

    for (const id of ids) document.getElementById(id)?.remove();
  });

  it('calls observer.disconnect on unmount', () => {
    const ids = ['section-a'];
    const el = document.createElement('div');
    el.id = 'section-a';
    document.body.appendChild(el);

    const { unmount } = renderHook(() => useTocScrollspy(ids));
    unmount();

    expect(disconnectSpy).toHaveBeenCalled();
    el.remove();
  });

  it('removes sections from active set when they stop intersecting', () => {
    const ids = ['section-a', 'section-b'];
    for (const id of ids) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }

    const { result } = renderHook(() => useTocScrollspy(ids));

    act(() => {
      observerCallback([{ target: document.getElementById('section-a')!, isIntersecting: true }]);
    });
    expect(result.current).toBe('section-a');

    act(() => {
      observerCallback([
        { target: document.getElementById('section-a')!, isIntersecting: false },
        { target: document.getElementById('section-b')!, isIntersecting: true },
      ]);
    });
    expect(result.current).toBe('section-b');

    for (const id of ids) document.getElementById(id)?.remove();
  });
});
