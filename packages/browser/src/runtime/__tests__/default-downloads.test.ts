import { expect, it, onTestFinished, vi } from 'vitest';
import type { Browser, CDPSession } from 'playwright-core';
import { DefaultDownloadOwner } from '../default-downloads.js';

/** Capture an exact rejected original, including a falsy reason, for qualified negative cleanup. */
async function rejected(original: Promise<unknown>): Promise<{ value: unknown }> {
  try {
    await original;
  } catch (value) {
    return { value };
  }
  throw new Error('EXPECTED_ORIGINAL_REJECTION');
}

// Stateful protocol doubles model detach resetting overrides; no native custody claim.
function fixture(release?: () => void, configureBrowser?: (browser: Browser) => void) {
  const original: { owner?: DefaultDownloadOwner } = {};
  const accepted: unknown[] = [];
  onTestFinished(async () => {
    let failure: { value: unknown } | undefined;
    try {
      release?.();
    } catch (value) {
      failure = { value };
    }
    try {
      original.owner?.retire();
    } catch (value) {
      failure ??= { value };
    }
    try {
      await original.owner?.close();
    } catch (value) {
      if (!accepted.some((reason) => Object.is(reason, value))) failure ??= { value };
    }
    if (failure) throw failure.value;
  });
  let behavior = 'default';
  let closed: (() => void) | undefined;
  const context = {};
  const send = vi.fn(async () => {
    behavior = 'deny';
  });
  const detach = vi.fn(async () => {
    behavior = 'default';
    closed?.();
  });
  const session = {
    send,
    detach,
    on: vi.fn((_event: string, callback: () => void) => {
      closed = callback;
    }),
    off: vi.fn(() => {
      closed = undefined;
    }),
  } as unknown as CDPSession;
  const contexts = vi.fn(() => [context]);
  const create = vi.fn(async () => session);
  let disconnected: ((original: Browser) => void) | undefined;
  const browserOn = vi.fn((_event: string, callback: (original: Browser) => void) => {
    disconnected = callback;
  });
  const browserOff = vi.fn(() => {
    disconnected = undefined;
  });
  const browser = {
    contexts,
    newBrowserCDPSession: create,
    on: browserOn,
    off: browserOff,
  } as unknown as Browser;
  configureBrowser?.(browser);
  const lost = vi.fn();
  let active = true;
  const owner = new DefaultDownloadOwner(browser, () => active, lost);
  original.owner = owner;
  return {
    owner,
    browserOn,
    browserOff,
    disconnected: (original: Browser = browser) => disconnected?.(original),
    acceptFailure: (value: unknown) => accepted.push(value),
    send,
    detach,
    contexts,
    create,
    context,
    lost,
    closed: () => closed?.(),
    revoke: () => {
      active = false;
    },
    behavior: () => behavior,
  };
}
it('retains deny across ordinary lifetime; the stateful detach mutant would restore allowance', async () => {
  const f = fixture();
  await f.owner.ready;
  expect(f.behavior()).toBe('deny');
  expect(f.detach).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(f.behavior()).toBe('deny');
  f.owner.retire();
  await f.owner.close();
  expect(f.detach).toHaveBeenCalledOnce();
  expect(f.behavior()).toBe('default');
  expect(f.lost).not.toHaveBeenCalled();
});
it('unexpected original session closure fences the actual owner and remains sticky', async () => {
  const f = fixture();
  await f.owner.ready;
  f.closed();
  expect(f.lost).toHaveBeenCalledOnce();
  const failure = await rejected(f.owner.close());
  expect(failure.value).toMatchObject({ code: 'OPERATION_FAILED' });
  f.acceptFailure(failure.value);
});

it('unexpected exact Browser disconnect stays a sticky refusal even though its connection is closed', async () => {
  const f = fixture();
  await f.owner.ready;
  f.disconnected();
  const failure = await rejected(f.owner.close());
  f.acceptFailure(failure.value);
  expect(failure.value).toMatchObject({ code: 'OPERATION_FAILED' });
  expect(f.lost).toHaveBeenCalledOnce();
  expect(f.detach).not.toHaveBeenCalled();
  await expect(f.owner.close()).rejects.toBe(failure.value);
});
it('a foreign Browser disconnect cannot qualify this original session cleanup', async () => {
  const f = fixture();
  await f.owner.ready;
  f.owner.retire();
  f.disconnected({} as Browser);
  const failure = await rejected(f.owner.close());
  f.acceptFailure(failure.value);
  expect(failure.value).toMatchObject({ code: 'OPERATION_FAILED' });
  expect(f.detach).toHaveBeenCalledOnce();
});
