import { expect, it, vi } from 'vitest';
import { joinBrowserBeforeShutdown } from '../shutdown-join.js';

it('fences both owners synchronously and joins both before disposing other services', async () => {
  let finishWorkspace!: () => void, finishBrowser!: () => void;
  const workspace = new Promise<void>((resolve) => {
    finishWorkspace = resolve;
  });
  const browser = new Promise<void>((resolve) => {
    finishBrowser = resolve;
  });
  const entered: string[] = [];
  const remaining = vi.fn(async () => {
    entered.push('remaining');
  });
  const completion = joinBrowserBeforeShutdown(
    () => {
      entered.push('browser');
      return browser;
    },
    remaining,
    () => {
      entered.push('workspace');
      return workspace;
    }
  );
  expect(entered).toEqual(['workspace', 'browser']);
  expect(remaining).not.toHaveBeenCalled();
  finishWorkspace();
  await workspace;
  expect(remaining).not.toHaveBeenCalled();
  finishBrowser();
  await completion;
  expect(entered).toEqual(['workspace', 'browser', 'remaining']);
});

it.each([undefined, null, false, 0])(
  'preserves a first synchronous workspace failure %s and still closes the browser',
  async (reason) => {
    const browser = vi.fn(async () => {
      throw new Error('later browser failure');
    });
    const remaining = vi.fn(async () => {
      throw new Error('later remaining failure');
    });
    await expect(
      joinBrowserBeforeShutdown(browser, remaining, () => {
        throw reason;
      })
    ).rejects.toBe(reason);
    expect(browser).toHaveBeenCalledOnce();
    expect(remaining).toHaveBeenCalledOnce();
  }
);

it('preserves the first asynchronous browser failure while a workspace disposal is held', async () => {
  let rejectWorkspace!: (reason: unknown) => void;
  const workspace = new Promise<void>((_, reject) => {
    rejectWorkspace = reject;
  });
  const original = new Error('original browser failure');
  const remaining = vi.fn(async () => {});
  const completion = joinBrowserBeforeShutdown(
    () => Promise.reject(original),
    remaining,
    () => workspace
  );
  await Promise.resolve();
  expect(remaining).not.toHaveBeenCalled();
  rejectWorkspace(new Error('later workspace failure'));
  await expect(completion).rejects.toBe(original);
  expect(remaining).toHaveBeenCalledOnce();
});
