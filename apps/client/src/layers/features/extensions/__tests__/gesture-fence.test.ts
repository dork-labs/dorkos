/**
 * The gesture fence (DOR-3293, Security's Musts, Nov 15): one app may open
 * another app's page only when the person acted inside that app's own frame.
 * Input to the host's page, focus the host did not see move in, a spent or
 * missing activation: each one refuses on its own.
 *
 * jsdom cannot make a trusted event, so host input goes through
 * `noteHostInput` with `isTrusted: true`; the real-Chromium half is
 * `apps/e2e/tests/extensions/app-navigate-gesture.spec.ts`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arriveAtAppPage, resetArrivalPause } from '../frame/app-arrival';
import { frameHasGesture, noteHostInput, resetGestureFence } from '../frame/gesture-fence';

/** Say whether the window has transient user activation right now. */
function activation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive, hasBeenActive: isActive },
  });
}

/** Focus moves into a frame and the host window blurs, as the browser does. */
function focusMovesInto(frame: HTMLIFrameElement): void {
  frame.focus();
  window.dispatchEvent(new FocusEvent('blur'));
}

/** The person clicks inside a frame: the browser raises activation, then focus moves in. */
function personClicksInto(frame: HTMLIFrameElement): void {
  activation(true);
  focusMovesInto(frame);
}

/** One trusted pointer, touch or key event on the host's own page. */
function hostInput(): void {
  noteHostInput({ isTrusted: true });
}

/** The activation runs out, and the fence's next look sees it. */
function activationEnds(): void {
  activation(false);
  vi.advanceTimersByTime(250);
}

/** A fresh frame in the page. */
function frame(): HTMLIFrameElement {
  const element = document.createElement('iframe');
  document.body.append(element);
  return element;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetGestureFence();
});
afterEach(() => {
  resetArrivalPause();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'userActivation');
  document.body.innerHTML = '';
  document.body.removeAttribute('inert');
});

describe('a gesture in the calling frame', () => {
  it('passes after the person clicked into that frame, with no host input', () => {
    const atlas = frame();
    personClicksInto(atlas);
    expect(frameHasGesture(atlas)).toBe(true);
  });

  it('refuses with no activation, and with no frame', () => {
    const atlas = frame();
    personClicksInto(atlas);
    activation(false);
    expect(frameHasGesture(atlas)).toBe(false);
    activation(true);
    expect(frameHasGesture(null)).toBe(false);
  });

  it('fails closed where the browser cannot say', () => {
    const atlas = frame();
    focusMovesInto(atlas);
    expect(frameHasGesture(atlas)).toBe(false);
  });
});

describe('rule 1: no input to the host’s own page in this activation', () => {
  it('refuses a host click, even when the frame then focuses itself', () => {
    const atlas = frame();
    activation(true);
    hostInput();
    // The frame takes focus after the click: the host sees focus move in.
    focusMovesInto(atlas);
    expect(frameHasGesture(atlas)).toBe(false);
  });

  it('refuses a host click after the person clicked into the frame', () => {
    const atlas = frame();
    personClicksInto(atlas);
    hostInput();
    expect(frameHasGesture(atlas)).toBe(false);
  });

  it('ignores events a script made', () => {
    const atlas = frame();
    personClicksInto(atlas);
    noteHostInput({ isTrusted: false });
    window.dispatchEvent(new PointerEvent('pointerdown'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(frameHasGesture(atlas)).toBe(true);
  });

  it('treats an activation already live when the fence started as the host’s', async () => {
    vi.resetModules();
    activation(true);
    const fence = await import('../frame/gesture-fence');
    const atlas = frame();
    focusMovesInto(atlas);
    expect(fence.frameHasGesture(atlas)).toBe(false);
    // Once it runs out, a real click into the frame counts.
    activationEnds();
    personClicksInto(atlas);
    expect(fence.frameHasGesture(atlas)).toBe(true);
    fence.resetGestureFence();
  });
});

describe('rule 2: the person moved focus into that frame, with no host input since', () => {
  it('refuses focus the host never saw move in', () => {
    const atlas = frame();
    atlas.focus();
    activation(true);
    expect(frameHasGesture(atlas)).toBe(false);
  });

  it('never arms a frame that focused itself, even once an activation comes', () => {
    const atlas = frame();
    // No activation as focus moves in: the frame did it, not the person.
    activation(false);
    focusMovesInto(atlas);
    activation(true);
    expect(frameHasGesture(atlas)).toBe(false);
  });

  it('refuses after a host click, until the person moves focus in again', () => {
    const atlas = frame();
    personClicksInto(atlas);
    hostInput();
    activationEnds();
    // Focus never left the frame, but the host had input since it moved in.
    activation(true);
    expect(frameHasGesture(atlas)).toBe(false);
    focusMovesInto(atlas);
    expect(frameHasGesture(atlas)).toBe(true);
  });

  it('refuses one frame riding focus the person moved into another', () => {
    const atlas = frame();
    const quill = frame();
    personClicksInto(quill);
    expect(frameHasGesture(atlas)).toBe(false);
    expect(frameHasGesture(quill)).toBe(true);
  });

  it('refuses once focus has left the frame', () => {
    const atlas = frame();
    personClicksInto(atlas);
    atlas.blur();
    expect(frameHasGesture(atlas)).toBe(false);
  });
});

describe('rule 3: one open per gesture', () => {
  it('spends the gesture: a second open in the same activation is refused', () => {
    const atlas = frame();
    personClicksInto(atlas);
    expect(frameHasGesture(atlas)).toBe(true);

    arriveAtAppPage(() => {});
    // The app puts focus back on its own frame, still inside the same activation.
    focusMovesInto(atlas);
    expect(frameHasGesture(atlas)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(frameHasGesture(atlas)).toBe(false);

    // Only once that activation has run out does a new click count again.
    activationEnds();
    personClicksInto(atlas);
    expect(frameHasGesture(atlas)).toBe(true);
  });
});
