import { expect, it, vi, onTestFinished } from 'vitest';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
import { BrowserPixelSubscriptions } from '../subscriptions.js';
import type { PrivateViewerCensus } from '../../runtime/private-native-acceptance.js';
it('observes the original empty viewer map periodically without creating a subscription or capture', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const rows: PrivateViewerCensus[] = [],
    capture = vi.fn();
  const original = new BrowserPixelSubscriptions({ capture }, undefined, (row) => rows.push(row));
  onTestFinished(() => original.close());
  await vi.advanceTimersByTimeAsync(2100);
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.subscriptions === 0 && !row.closed)).toBe(true);
  expect(capture).not.toHaveBeenCalled();
  await original.close();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, undefined])(
  'a census callback first failure %s retires its original timer and remains a failed close',
  async (value) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let calls = 0;
    const original = new BrowserPixelSubscriptions({ capture: vi.fn() }, undefined, () => {
      if (++calls === 2) throw value;
    });
    onTestFinished(async () => {
      await Promise.allSettled([original.close()]);
    });
    await vi.advanceTimersByTimeAsync(1100);
    await expect(original.close()).rejects.toBe(value);
    expect(vi.getTimerCount()).toBe(0);
  }
);
it('a constructor census failure installs no unowned timer', () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  expect(
    () =>
      new BrowserPixelSubscriptions({ capture: vi.fn() }, undefined, () => {
        throw new Error('original-census-failure');
      })
  ).toThrow('original-census-failure');
  expect(vi.getTimerCount()).toBe(0);
});

const originalBinding = BrowserBindingSchema.parse({
  browserId: 'B'.repeat(22),
  browserGeneration: 1,
  tabId: 'T'.repeat(22),
  epoch: 1,
  inputGeneration: 1,
  navigationGeneration: 0,
  viewportVersion: 0,
});
const originalOrigin = 'http://127.0.0.1:4242';
it('reports actual original issue and disconnect as zero, one and zero without acquiring pixels', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const rows: PrivateViewerCensus[] = [],
    capture = vi.fn(async () => {
      throw new Error('capture must not enter');
    });
  const pixels = new BrowserPixelSubscriptions({ capture }, undefined, (row) => rows.push(row));
  onTestFinished(() => pixels.close());
  const viewer = pixels.issue(
    { binding: originalBinding, actorIdentity: {}, refresh: async () => {}, current: () => true },
    originalOrigin
  );
  expect(pixels.ownsTicket(viewer.token)).toBe(true);
  expect(pixels.viewerCount()).toBe(1);
  pixels.disconnect(viewer.token);
  expect(rows.map((row) => row.subscriptions)).toEqual([0, 1, 0]);
  expect(rows.every((row) => !row.closed)).toBe(true);
  expect(pixels.ownsTicket(viewer.token)).toBe(false);
  expect(pixels.viewerCount()).toBe(0);
  expect(capture).not.toHaveBeenCalled();
  await pixels.close();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, undefined])(
  'census reentry during issue refuses publication and joins original held capture failure %s',
  async (cause) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let entered!: () => void, rejectCapture!: (cause: unknown) => void;
    const captureEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<never>((_, reject) => {
      rejectCapture = reject;
    });
    const capture = vi.fn(() => {
      entered();
      return held;
    });
    const rows: PrivateViewerCensus[] = [];
    const owned: { close?: Promise<void>; next?: Promise<unknown> } = {};
    const pixels = new BrowserPixelSubscriptions({ capture }, undefined, (row) => {
      rows.push(row);
      if (row.subscriptions === 2 && !row.closed) {
        owned.close = pixels.close();
        void owned.close.catch(() => {});
      }
    });
    onTestFinished(async () => {
      rejectCapture(cause);
      await Promise.allSettled([...(owned.next ? [owned.next] : []), pixels.close()]);
    });
    const actor = {};
    const proof = {
      binding: originalBinding,
      actorIdentity: actor,
      refresh: async () => {},
      current: () => true,
    };
    const firstViewer = pixels.issue(proof, originalOrigin);
    let published = false;
    owned.next = pixels.next(firstViewer.token, originalOrigin, actor).then((frame) => {
      published = true;
      return frame;
    });
    void owned.next.catch(() => {});
    await captureEntered;
    let issued: unknown;
    expect(() => {
      issued = pixels.issue(proof, originalOrigin);
    }).toThrowError(expect.objectContaining({ reason: 'authority' }));
    expect(issued).toBeUndefined();
    expect(pixels.viewerCount()).toBe(0);
    expect(pixels.ownsTicket(firstViewer.token)).toBe(false);
    expect(rows.map((row) => row.subscriptions)).toEqual([0, 1, 2, 1, 0]);
    expect(rows.at(-1)?.closed).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const closing = owned.close;
    if (!closing) throw new Error('original observer did not enter close');
    let returned = false;
    void closing.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      }
    );
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(published).toBe(false);
    rejectCapture(cause);
    await expect(owned.next).rejects.toBe(cause);
    await expect(closing).rejects.toBe(cause);
    expect(returned).toBe(true);
    expect(published).toBe(false);
  }
);
