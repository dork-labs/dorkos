import { expect, it, onTestFinished, vi } from 'vitest';
const producers = vi.hoisted(() => ({
  authority: { stopAndJoin: vi.fn(async (): Promise<void> => {}) },
  runtime: { close: vi.fn(async (): Promise<void> => {}) },
}));
vi.mock('../live/authority-core.js', () => ({
  createBrowserAuthorityCore: () => producers.authority,
}));
vi.mock('../../../runtime/production-owner.js', () => ({
  createProductionBrowserRuntimeOwner: () => producers.runtime,
}));
import {
  createProductionBrowserAuthority,
  isOriginalProductionBrowserAuthority,
} from '../live/production-authority.js';

it.each([undefined, false])(
  'joins both captured original owners and retains first close rejection %s',
  async (reason) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closeBank: { closing?: Promise<void> } = {};
    const stop = vi.fn(async () => {
      await held;
      throw reason;
    });
    const runtimeClose = vi.fn(async () => {
      throw new Error('SECONDARY_CLOSE');
    });
    onTestFinished(async () => {
      release();
      if (closeBank.closing) {
        const result = await Promise.allSettled([closeBank.closing]);
        if (result[0]!.status !== 'rejected' || !Object.is(result[0]!.reason, reason))
          throw new Error('ORIGINAL_CAUSE_NOT_RETAINED');
      }
    });
    producers.authority.stopAndJoin = stop;
    producers.runtime.close = runtimeClose;
    const original = createProductionBrowserAuthority(
      {} as Parameters<typeof createProductionBrowserAuthority>[0]
    );
    expect(isOriginalProductionBrowserAuthority(original)).toBe(true);
    expect(isOriginalProductionBrowserAuthority({ ...original })).toBe(false);
    const replacement = vi.fn(async () => {});
    producers.authority.stopAndJoin = replacement;
    producers.runtime.close = replacement;
    closeBank.closing = original.close();
    void closeBank.closing.catch(() => {});
    expect(original.close()).toBe(closeBank.closing);
    expect(stop).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    let settled = false;
    void closeBank.closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(closeBank.closing).rejects.toBe(reason);
  }
);
