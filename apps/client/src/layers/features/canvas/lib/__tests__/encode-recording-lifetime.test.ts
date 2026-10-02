/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { drawFrames } from '../encode-recording';
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('decodes sequentially and disposes image, compressed inputs and canvas after cancellation during decode', async () => {
  const images: DeferredImage[] = [];
  class DeferredImage {
    width = 1;
    height = 1;
    src = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      images.push(this);
    }
  }
  vi.stubGlobal('Image', DeferredImage);
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: draw,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  } as unknown as CanvasRenderingContext2D);
  const create = document.createElement.bind(document);
  const canvases: HTMLCanvasElement[] = [];
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = create(tag);
    if (tag === 'canvas') canvases.push(element as HTMLCanvasElement);
    return element;
  });
  let live = true;
  const inputs = [PNG, PNG, PNG];
  const result = drawFrames(inputs, 800, () => {
    if (!live) throw new Error('retired');
  });
  const rejected = expect(result).rejects.toThrow('retired');
  expect(images).toHaveLength(1);
  images[0].onload!();
  await Promise.resolve();
  expect(images).toHaveLength(2);
  expect(images[0].src).toBe('');
  expect(inputs[0]).toBe('');
  live = false;
  images[1].onload!();
  await rejected;
  expect(images).toHaveLength(2);
  expect(
    images.every((image) => image.src === '' && image.onload === null && image.onerror === null)
  ).toBe(true);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(inputs).toHaveLength(0);
  expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
