import { describe, expect, it } from 'vitest';
import { containedBox, flipFromThumbnail } from '../flip';

describe('containedBox', () => {
  it('fits a wide picture to the box width, centred', () => {
    const box = containedBox(
      { width: 2000, height: 1000 },
      { left: 0, top: 0, width: 1000, height: 1000 },
      true
    );
    expect(box).toEqual({ left: 0, top: 250, width: 1000, height: 500 });
  });

  it('never draws a small picture larger than itself unless asked', () => {
    const box = containedBox(
      { width: 200, height: 100 },
      { left: 0, top: 0, width: 1000, height: 1000 },
      false
    );
    expect(box).toEqual({ left: 400, top: 450, width: 200, height: 100 });
  });
});

describe('flipFromThumbnail', () => {
  /** A loaded thumbnail drawn at this rectangle. */
  function thumb(rect: { left: number; top: number; width: number; height: number }) {
    const img = document.createElement('img');
    Object.defineProperty(img, 'naturalWidth', { value: 1000 });
    Object.defineProperty(img, 'naturalHeight', { value: 500 });
    img.getBoundingClientRect = () =>
      ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
    return img;
  }
  const stage = { left: 0, top: 0, width: 1000, height: 1000 };
  const viewport = { width: 1000, height: 1000 };

  it('puts the big picture over the thumbnail', () => {
    const offset = flipFromThumbnail(
      thumb({ left: 100, top: 100, width: 200, height: 100 }),
      stage,
      viewport
    );
    // The thumbnail's centre (200, 150) relative to the stage's (500, 500), at
    // a fifth of the 1000px the viewer draws it.
    expect(offset).toEqual({ x: -300, y: -350, scale: 0.2 });
  });

  it('has nothing to grow from when the thumbnail is scrolled away', () => {
    expect(
      flipFromThumbnail(thumb({ left: 100, top: -400, width: 200, height: 100 }), stage, viewport)
    ).toBeNull();
  });
});
