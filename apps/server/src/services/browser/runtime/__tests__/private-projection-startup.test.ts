import { expect, it, vi } from 'vitest';
import { joinOriginalProjectionStartupFailure } from '../private-acceptance.js';

it.each([false, undefined])(
  'joins a held original send while retaining startup failure %s',
  async (cause) => {
    let returnSend!: () => void;
    const held = new Promise<void>((resolve) => {
      returnSend = resolve;
    });
    const beginClose = vi.fn();
    const close = vi.fn(() => held);
    const joined = joinOriginalProjectionStartupFailure({ beginClose, close }, cause);
    expect(beginClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    let returned = false;
    void joined.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    returnSend();
    const result = await joined;
    expect(result.cause).toBe(cause);
    expect(result.cleanup.every((row) => row.status === 'fulfilled')).toBe(true);
  }
);
it('captures original close before reentrant beginClose replaces the facade', async () => {
  const originalClose = vi.fn(async () => {}),
    replacement = vi.fn(async () => {});
  const projection = {
    beginClose: () => {
      projection.close = replacement;
    },
    close: originalClose,
  };
  const result = await joinOriginalProjectionStartupFailure(projection, undefined);
  expect(result.cause).toBeUndefined();
  expect(originalClose).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
});
it.each([false, undefined])(
  'retains exact cleanup failure %s separately from the startup cause',
  async (failure) => {
    const cause = new Error('original startup');
    const result = await joinOriginalProjectionStartupFailure(
      {
        beginClose: () => {
          throw failure;
        },
        close: async () => {
          throw new Error('later close');
        },
      },
      cause
    );
    expect(result.cause).toBe(cause);
    expect(result.cleanup[0]).toEqual({ status: 'rejected', reason: failure });
    expect(result.cleanup[1]?.status).toBe('rejected');
  }
);
it('leaves an unarmed absent projection without any close duty', async () => {
  expect(await joinOriginalProjectionStartupFailure(undefined, false)).toEqual({
    cause: false,
    cleanup: [],
  });
});
