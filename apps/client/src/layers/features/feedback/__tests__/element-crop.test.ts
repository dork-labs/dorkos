// The crop arithmetic, at every scale and every edge.
//
// This is the one part of "point at element" that a person cannot check by
// looking: a crop that is off by the device pixel ratio, or by the scroll
// offset, still produces a perfectly plausible picture — of the wrong thing.
// `computeElementCrop` is pure precisely so all of that is reachable here
// without a browser, a canvas, or a rasterizer.
//
// jsdom limit worth naming: the DRAWING half (`cropShotToElement`) is not
// checked here. It decodes an image and calls `drawImage`, and jsdom has no
// codec and no 2d context — a test of it would only be a test of its own mocks.
// The real browser answers that, in
// `apps/e2e/tests/dev-playground/feedback-point-at-element.spec.ts`.
import { describe, it, expect } from 'vitest';
import {
  computeElementCrop,
  ELEMENT_CROP_PADDING_PX,
  type ElementCropInput,
} from '../lib/element-crop';

/** A 1000x800 window, captured by the shell at the given device pixel ratio. */
function shellCapture(dpr: number): Omit<ElementCropInput, 'element'> {
  return {
    viewport: { width: 1000, height: 800 },
    region: { left: 0, top: 0, width: 1000, height: 800 },
    image: { width: 1000 * dpr, height: 800 * dpr },
  };
}

describe('computeElementCrop — device pixel ratio', () => {
  it('takes CSS pixels straight across on a 1x display', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 100, top: 100, width: 200, height: 50 },
    });

    // The element, plus 24px of context on every side.
    expect(crop).toEqual({ sx: 76, sy: 76, sw: 248, sh: 98 });
  });

  it('doubles every number on a 2x display, where the picture has twice the pixels', () => {
    const crop = computeElementCrop({
      ...shellCapture(2),
      element: { left: 100, top: 100, width: 200, height: 50 },
    });

    // The identical gesture on a retina window. Skipping this conversion is the
    // classic version of this bug: the crop lands on the top-left QUARTER of
    // what was pointed at, and looks like a real screenshot of something else.
    expect(crop).toEqual({ sx: 152, sy: 152, sw: 496, sh: 196 });
  });

  it('scales each axis on its own rather than by one shared ratio', () => {
    // A capture that is not uniformly scaled — letterboxed, or rounded
    // differently per axis. One shared ratio skews the crop along one axis only,
    // which is the kind of wrong that looks almost right.
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 0, top: 0, width: 1000, height: 800 },
      image: { width: 2000, height: 800 },
      element: { left: 100, top: 100, width: 200, height: 50 },
      padding: 0,
    });

    expect(crop).toEqual({ sx: 200, sy: 100, sw: 400, sh: 50 });
  });
});

describe('computeElementCrop — the padding', () => {
  it('leaves a default gutter around the element so the crop is recognisable', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 400, top: 400, width: 100, height: 100 },
    });

    expect(crop?.sw).toBe(100 + ELEMENT_CROP_PADDING_PX * 2);
    expect(crop?.sh).toBe(100 + ELEMENT_CROP_PADDING_PX * 2);
  });

  it('cuts exactly at the element’s edges when asked for no padding', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 400, top: 400, width: 100, height: 100 },
      padding: 0,
    });

    expect(crop).toEqual({ sx: 400, sy: 400, sw: 100, sh: 100 });
  });
});

describe('computeElementCrop — clamping to what can be seen', () => {
  it('does not read past the top-left corner for an element in it', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 0, top: 0, width: 100, height: 40 },
    });

    // The padding would run to -24 on both axes. A negative source rectangle is
    // not an error in canvas — it is a band of transparent pixels down two edges
    // of the picture, which is why this has to be clamped rather than trusted.
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 124, sh: 64 });
  });

  it('does not read past the bottom-right corner either', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 950, top: 780, width: 60, height: 40 },
    });

    expect(crop).toEqual({ sx: 926, sy: 756, sw: 74, sh: 44 });
  });

  it('keeps only the visible half of an element scrolled part-way off the top', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 100, top: -30, width: 200, height: 50 },
    });

    // 20px of the element is on screen, plus 24px of padding below it — and
    // nothing above zero, because there is nothing above zero to show.
    expect(crop).toEqual({ sx: 76, sy: 0, sw: 248, sh: 44 });
  });

  it('refuses an element that is not on screen at all', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 100, top: 900, width: 200, height: 50 },
    });

    // Nothing of it is in the picture, so there is no crop to make. `null` lets
    // the caller say so; a clamped rectangle would hand back a confident
    // screenshot of whatever happens to sit at the bottom edge instead.
    expect(crop).toBeNull();
  });
});

describe('computeElementCrop — a picture that is not the window', () => {
  it('offsets by the region when the capture starts above the viewport', () => {
    // The DOM path frames `#root`, which on a scrolled page begins above the top
    // of the window. Ignoring `region.top` puts every crop off by exactly the
    // scroll offset — always plausible, always wrong.
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 0, top: -500, width: 1000, height: 3000 },
      image: { width: 1000, height: 3000 },
      element: { left: 100, top: 200, width: 200, height: 50 },
    });

    expect(crop).toEqual({ sx: 76, sy: 676, sw: 248, sh: 98 });
  });

  it('clips to the picture as well as to the window when the two differ', () => {
    // A captured element inset from the left of the window: the 50px strip of
    // viewport beside it is visible but is not IN the picture.
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 50, top: 0, width: 900, height: 800 },
      image: { width: 900, height: 800 },
      element: { left: 10, top: 100, width: 100, height: 40 },
    });

    expect(crop).toEqual({ sx: 0, sy: 76, sw: 84, sh: 88 });
  });

  it('stops at the fold for an element the picture continues past', () => {
    // The two clips are NOT the same clip. The picture here contains 3000px of
    // page; the person can see 800 of it. An element running past the fold must
    // be cropped at the fold, because the crop's promise is "what you were
    // looking at" — not "what the capture happened to contain".
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 0, top: -500, width: 1000, height: 3000 },
      image: { width: 1000, height: 3000 },
      element: { left: 100, top: 700, width: 200, height: 400 },
    });

    // 676→800 on screen, offset by the 500px of picture above the window.
    expect(crop).toEqual({ sx: 76, sy: 1176, sw: 248, sh: 124 });
  });

  it('refuses an element scrolled off the top, even though it is in the picture', () => {
    // Above the fold and inside the frame at once — the case that only the
    // viewport clip can refuse. Without it this crops a real, sharp picture of
    // something the reporter was not looking at.
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 0, top: -500, width: 1000, height: 3000 },
      image: { width: 1000, height: 3000 },
      element: { left: 100, top: -400, width: 200, height: 100 },
      padding: 0,
    });

    expect(crop).toBeNull();
  });

  it('refuses when the element is on screen but outside the picture', () => {
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 600, top: 0, width: 400, height: 800 },
      image: { width: 400, height: 800 },
      element: { left: 10, top: 100, width: 100, height: 40 },
    });

    expect(crop).toBeNull();
  });
});

describe('computeElementCrop — degenerate input', () => {
  it('still returns at least one pixel for a hairline element', () => {
    const crop = computeElementCrop({
      ...shellCapture(1),
      element: { left: 500, top: 400, width: 200, height: 1 },
      padding: 0,
    });

    // A 1px divider is a real thing to point at, and a zero-height canvas is one
    // the browser refuses to encode at all.
    expect(crop).toEqual({ sx: 500, sy: 400, sw: 200, sh: 1 });
  });

  it('still returns at least one pixel when the scale rounds the element away', () => {
    // A heavily downscaled capture: a 1px box maps to less than one image pixel.
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 0, top: 0, width: 1000, height: 800 },
      image: { width: 10, height: 8 },
      element: { left: 500, top: 400, width: 1, height: 1 },
      padding: 0,
    });

    expect(crop?.sw).toBe(1);
    expect(crop?.sh).toBe(1);
  });

  it('never starts a crop outside the picture, even at the far edge', () => {
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 0, top: 0, width: 1000, height: 800 },
      image: { width: 10, height: 8 },
      element: { left: 999, top: 799, width: 1, height: 1 },
      padding: 0,
    });

    expect(crop?.sx).toBeLessThan(10);
    expect(crop?.sy).toBeLessThan(8);
    expect(crop && crop.sx + crop.sw).toBeLessThanOrEqual(10);
    expect(crop && crop.sy + crop.sh).toBeLessThanOrEqual(8);
  });

  it('refuses a capture that reports no area', () => {
    // A region or an image of zero size would divide by zero and produce
    // `Infinity` / `NaN` coordinates, which canvas silently accepts.
    expect(
      computeElementCrop({
        ...shellCapture(1),
        region: { left: 0, top: 0, width: 0, height: 800 },
        element: { left: 100, top: 100, width: 50, height: 50 },
      })
    ).toBeNull();
    expect(
      computeElementCrop({
        ...shellCapture(1),
        image: { width: 0, height: 0 },
        element: { left: 100, top: 100, width: 50, height: 50 },
      })
    ).toBeNull();
  });

  it('rounds both edges rather than rounding the width, so a crop cannot drift', () => {
    // Fractional CSS pixels are ordinary (a flex child at 1.5x zoom). Rounding
    // the WIDTH instead of the far edge lets the same box come back a pixel
    // wider or narrower depending only on where it happens to sit.
    const crop = computeElementCrop({
      viewport: { width: 1000, height: 800 },
      region: { left: 0, top: 0, width: 1000, height: 800 },
      image: { width: 2000, height: 1600 },
      element: { left: 100.4, top: 100.4, width: 33.3, height: 33.3 },
      padding: 0,
    });

    // At 2x: left 200.8 → 201, right 267.4 → 267, so the crop is 66px wide.
    // Rounding the width instead would give 201 + round(66.6) = 268, a crop a
    // pixel wider than the box it was measured from — and a pixel narrower for
    // the same element sitting somewhere else on the page.
    expect(crop).toEqual({ sx: 201, sy: 201, sw: 66, sh: 66 });
  });
});
