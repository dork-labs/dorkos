import type { BrowserContext } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { createFixtureContextCustody } from './fixture-custody.js';

it('retains an original pending launch and closes its late context exactly once after timeout cleanup', async () => {
  let resolve!: (value: BrowserContext) => void;
  const pending = new Promise<BrowserContext>((done) => {
    resolve = done;
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const context = { close } as unknown as BrowserContext;
  const owner = createFixtureContextCustody();
  const original = owner.acquire(() => pending);
  expect((await owner.cleanup(1)).state).toBe('held');
  resolve(context);
  await original;
  expect((await owner.cleanup(100)).state).toBe('closed');
  expect(close).toHaveBeenCalledTimes(1);
});
it('preserves a failed original close and never substitutes another close attempt', async () => {
  const primary = new Error('original close failed');
  const close = vi.fn().mockRejectedValue(primary);
  const context = { close } as unknown as BrowserContext;
  const owner = createFixtureContextCustody();
  await owner.acquire(async () => context);
  expect(await owner.cleanup(100)).toEqual({ state: 'held', firstCause: primary });
  expect(await owner.cleanup(100)).toEqual({ state: 'held', firstCause: primary });
  expect(close).toHaveBeenCalledTimes(1);
  await expect(owner.acquire(async () => context)).rejects.toThrow('FIXTURE_ACQUISITION_CLOSED');
});
