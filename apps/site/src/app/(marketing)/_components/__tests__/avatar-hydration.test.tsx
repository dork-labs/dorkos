/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { Avatar } from '../cast/Avatar';

/**
 * The listeners motion registers on the reduced-motion media query.
 *
 * `useReducedMotion` reads a module-level singleton that is filled in once,
 * from `matchMedia`, and kept current by a `change` listener. Firing that
 * listener is the only way to move the preference for a second render without
 * reloading motion into a second copy of React.
 */
const listeners: Array<() => void> = [];

/** What `matchMedia('(prefers-reduced-motion)')` currently answers. */
let reduced = false;

/**
 * Put the preference back where a fresh visitor's is.
 *
 * The singleton outlives a test, and motion only fills it in once, so this
 * moves it the same way a person changing the setting would rather than by
 * reaching into motion's internals.
 */
function prefersMotion(): void {
  reduced = false;
  for (const listener of listeners) listener();
}

/** A media query list whose answer this test can change afterwards. */
function stubMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return reduced;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: vi.fn(),
      addListener: (listener: () => void) => listeners.push(listener),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

/** Turn the preference on, the way a person changing it mid-session would. */
function prefersReducedMotion(): void {
  reduced = true;
  for (const listener of listeners) listener();
}

/** The one element the avatar paints its face with. */
function faceTag(root: ParentNode): string | undefined {
  return root.querySelector('span > *')?.tagName;
}

const play = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  play.mockClear();
  stubMatchMedia();
  prefersMotion();

  class SeenObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', SeenObserver);
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    writable: true,
    configurable: true,
    value: play,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the faces survive hydration', () => {
  it('paints the same element on the server and on a reduced-motion client', () => {
    // The server cannot know the preference, so it always renders the
    // unreduced branch. If the preference picks the element *type*, React
    // finds an `<img>` where the server put a `<video>`, throws #418, and
    // re-renders the entire page on the client — for exactly the cohort that
    // asked for less work. Both renders have to agree on the tag.
    const server = document.createElement('div');
    server.innerHTML = renderToString(<Avatar who="otto" size={48} />);
    const serverTag = faceTag(server);

    prefersReducedMotion();
    const { container } = render(<Avatar who="otto" size={48} />);

    expect(serverTag, 'the server rendered no face at all').toBeDefined();
    expect(faceTag(container)).toBe(serverTag);
  });

  it('still lets the preference decide whether the face moves', () => {
    // Same element, different behaviour: the loop is only ever started for a
    // visitor who did not ask for stillness. Without this, "one element
    // always" would be indistinguishable from ignoring the preference.
    render(<Avatar who="otto" size={48} />);
    expect(play).toHaveBeenCalled();

    cleanup();
    play.mockClear();
    prefersReducedMotion();

    render(<Avatar who="otto" size={48} />);
    expect(play).not.toHaveBeenCalled();
  });
});
