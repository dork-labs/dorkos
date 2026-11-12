/**
 * After an app opens another app's page (DOR-3293, Security's Must): input to
 * the window is dropped for the first 500 ms, so a click timed for the old page
 * never lands on the new one, and the new page fades in over 150 ms unless the
 * person asks for less motion. The pause applies either way.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARRIVAL_PAUSE_MS,
  arriveAtAppPage,
  frameHasGesture,
  resetArrivalPause,
} from '../frame/app-arrival';

/** Answer `prefers-reduced-motion` as asked. */
function reducedMotion(on: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: on && query.includes('prefers-reduced-motion'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}

/** The routed page, which the fade animates. */
function page(): { animate: ReturnType<typeof vi.fn> } {
  const main = document.createElement('main');
  main.id = 'app-tab-panel';
  const animate = vi.fn();
  Object.assign(main, { animate });
  document.body.append(main);
  return { animate };
}

/** Count clicks that reach the page. */
function clicksReaching(target: HTMLElement): () => number {
  let count = 0;
  target.addEventListener('click', () => {
    count += 1;
  });
  return () => count;
}

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion(false);
});
afterEach(() => {
  resetArrivalPause();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.removeAttribute('inert');
});

describe('the pause after arriving on another app’s page', () => {
  it('drops a click inside the first 500 ms, and lets one through after', () => {
    const { animate } = page();
    const button = document.createElement('button');
    document.body.append(button);
    const reached = clicksReaching(button);
    const go = vi.fn();

    arriveAtAppPage(go);
    expect(go).toHaveBeenCalledOnce();
    button.click();
    expect(reached()).toBe(0);
    expect(document.body.hasAttribute('inert')).toBe(true);

    vi.advanceTimersByTime(ARRIVAL_PAUSE_MS - 1);
    button.click();
    expect(reached()).toBe(0);

    vi.advanceTimersByTime(1);
    button.click();
    expect(reached()).toBe(1);
    expect(document.body.hasAttribute('inert')).toBe(false);
    expect(animate).toHaveBeenCalledOnce();
  });

  it('drops keys too, and moves focus out of the calling frame', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frame.focus();
    let keys = 0;
    window.addEventListener('keydown', () => {
      keys += 1;
    });

    arriveAtAppPage(() => {});
    expect(document.activeElement).not.toBe(frame);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(keys).toBe(0);

    vi.advanceTimersByTime(ARRIVAL_PAUSE_MS);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(keys).toBe(1);
  });

  it('starts the pause when the navigation starts, before the page moves', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const reached = clicksReaching(button);
    // A click that lands while the router is still switching pages is dropped.
    arriveAtAppPage(() => button.click());
    expect(reached()).toBe(0);
  });

  it('fades the new page in over 150 ms, ease-out', () => {
    const { animate } = page();
    arriveAtAppPage(() => {});
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: 0 }, { opacity: 1 }],
      expect.objectContaining({ duration: 150, easing: 'cubic-bezier(0, 0, 0.2, 1)' })
    );
  });

  it('shows the page at once under reduced motion, and still pauses input', () => {
    reducedMotion(true);
    const { animate } = page();
    const button = document.createElement('button');
    document.body.append(button);
    const reached = clicksReaching(button);

    arriveAtAppPage(() => {});
    expect(animate).not.toHaveBeenCalled();
    button.click();
    expect(reached()).toBe(0);

    vi.advanceTimersByTime(ARRIVAL_PAUSE_MS);
    button.click();
    expect(reached()).toBe(1);
  });

  it('leaves the body inert after the pause if something else made it inert first', () => {
    document.body.setAttribute('inert', '');
    arriveAtAppPage(() => {});
    vi.advanceTimersByTime(ARRIVAL_PAUSE_MS);
    expect(document.body.hasAttribute('inert')).toBe(true);
  });
});

describe('a fresh gesture in the calling frame', () => {
  /** Say whether the window has transient user activation right now. */
  function activation(isActive: boolean): void {
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive, hasBeenActive: isActive },
    });
  }
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'userActivation');
  });

  it('needs both a live activation and focus in that very frame', () => {
    const atlas = document.createElement('iframe');
    const quill = document.createElement('iframe');
    document.body.append(atlas, quill);

    activation(true);
    atlas.focus();
    expect(frameHasGesture(atlas)).toBe(true);
    // The person's click was in Quill's frame: Atlas cannot ride it.
    quill.focus();
    expect(frameHasGesture(atlas)).toBe(false);

    activation(false);
    atlas.focus();
    expect(frameHasGesture(atlas)).toBe(false);
  });

  it('fails closed where the browser cannot say', () => {
    const atlas = document.createElement('iframe');
    document.body.append(atlas);
    atlas.focus();
    expect(frameHasGesture(atlas)).toBe(false);
  });
});
