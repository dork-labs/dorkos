import { vi } from 'vitest';

/**
 * What the stage needs from a browser that jsdom does not have.
 *
 * The stage is built out of observers, a scroll position and looping videos,
 * none of which jsdom implements. Stubbing them here rather than inline keeps
 * the test about the stage.
 *
 * `IntersectionObserver` reports everything as on screen the moment it is
 * observed, which is what makes the conversation start: in a real browser the
 * stage is what the visitor is looking at by the time it plays.
 */
export function stubBrowser(): void {
  class ImmediateObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  // jsdom leaves `document.scrollingElement` null, and motion reads the page's
  // scroll off exactly that: with nothing there its scroll tracking installs
  // no listener at all and silently reports a page that never moves.
  Object.defineProperty(document, 'scrollingElement', {
    value: document.documentElement,
    configurable: true,
  });

  vi.stubGlobal('IntersectionObserver', ImmediateObserver);
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('scrollTo', vi.fn());
  window.HTMLElement.prototype.scrollIntoView = vi.fn();

  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    writable: true,
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
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

/** Wait for the browser to paint, which is when motion publishes a new scroll position. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Put the reader at the end of the stage.
 *
 * Motion reads the scroll off `document.scrollingElement`, so that is what
 * moves here — a `window.scrollY` nobody reads would be a test that passes
 * while the page never scrolls. jsdom lays everything out at zero height, so
 * the stage's scroll span collapses to the one-pixel floor
 * `use-section-progress` puts under it, and one pixel is the whole animation.
 * That is enough to ask the question these tests care about: does the last
 * beat arrive when the scroll ends.
 */
export function scrollToEndOfStage(): void {
  // jsdom's test document has no doctype, so it is in quirks mode and
  // `scrollingElement` is <body>, not <html>. Motion reads whichever one the
  // document says, so the test has to move that one.
  const scroller = document.scrollingElement ?? document.documentElement;
  Object.defineProperty(scroller, 'scrollTop', { value: 1, writable: true, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 1, writable: true, configurable: true });
  window.dispatchEvent(new Event('scroll'));
}
