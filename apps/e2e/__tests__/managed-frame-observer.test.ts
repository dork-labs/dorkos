import { expect, it, vi } from 'vitest';
import { retainOriginalFramePerformanceFailure } from '../fixtures/managed-frame-observer';

it.each([false, undefined])(
  'joins a held original observation before retaining first cause %s despite sink failure',
  async (value) => {
    const first = Object.freeze({ value });
    let release!: (observation: unknown) => void;
    const original = new Promise<unknown>((yes) => {
      release = yes;
    });
    const observe = vi.fn(() => original);
    const retain = vi.fn(async () => {
      throw new Error('LATER_DIAGNOSTIC_SINK');
    });
    let returned = false;
    const work = retainOriginalFramePerformanceFailure(first, observe, retain);
    void work.then(() => {
      returned = true;
    });
    const actual = Object.freeze({ inputEvents: 1, lastDrawnRevision: 0 });
    try {
      expect(observe).toHaveBeenCalledOnce();
      expect(retain).not.toHaveBeenCalled();
      expect(returned).toBe(false);
      release(actual);
      expect(await work).toBe(first);
      expect(retain).toHaveBeenCalledExactlyOnceWith(actual);
    } finally {
      release(actual);
      await work;
    }
  }
);
it.each([false, undefined])(
  'does not replace first assertion with original diagnostic producer refusal %s',
  async (value) => {
    const first = Object.freeze({ value: new Error('ORIGINAL_SAMPLE_ASSERTION') });
    const retain = vi.fn(async () => {});
    expect(
      await retainOriginalFramePerformanceFailure(
        first,
        async () => {
          throw value;
        },
        retain
      )
    ).toBe(first);
    expect(retain).not.toHaveBeenCalled();
  }
);
