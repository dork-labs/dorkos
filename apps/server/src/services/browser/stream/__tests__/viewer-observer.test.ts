import { expect, it } from 'vitest';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
import { BrowserPixelSubscriptions } from '../subscriptions.js';

const binding = BrowserBindingSchema.parse({
  browserId: 'B'.repeat(22),
  browserGeneration: 1,
  tabId: 'T'.repeat(22),
  epoch: 1,
  inputGeneration: 1,
  navigationGeneration: 0,
  viewportVersion: 0,
});

it('refuses issuing pixels when the private original observer revokes admission', async () => {
  let current = true;
  const pixels = new BrowserPixelSubscriptions(
    {
      capture: async () => {
        throw new Error('not entered');
      },
    },
    () => {
      current = false;
    }
  );
  try {
    expect(() =>
      pixels.issue(
        { binding, actorIdentity: {}, refresh: async () => {}, current: () => current },
        'http://127.0.0.1:4242'
      )
    ).toThrowError(expect.objectContaining({ reason: 'authority' }));
    expect(pixels.viewerCount()).toBe(0);
  } finally {
    await pixels.close();
  }
});

it.each([false, undefined])(
  'retains original observer failure %s and removes the refused viewer',
  async (value) => {
    const pixels = new BrowserPixelSubscriptions(
      {
        capture: async () => {
          throw new Error('not entered');
        },
      },
      () => {
        throw value;
      }
    );
    let failure: { value: unknown } | undefined;
    try {
      pixels.issue(
        { binding, actorIdentity: {}, refresh: async () => {}, current: () => true },
        'http://127.0.0.1:4242'
      );
    } catch (value) {
      failure = { value };
    }
    expect(failure).toEqual({ value });
    expect(pixels.viewerCount()).toBe(0);
    const closed = await Promise.allSettled([pixels.close()]);
    expect(closed).toEqual([{ status: 'rejected', reason: value }]);
  }
);
