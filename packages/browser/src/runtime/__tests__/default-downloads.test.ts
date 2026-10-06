import { expect, it, onTestFinished, vi } from 'vitest';
import type { Browser, CDPSession, Page } from 'playwright-core';
import { DefaultDownloadOwner, closeBrowserAndDownloads } from '../default-downloads.js';
import { createPageTransport, type PageTransportOptions } from '../../input/page-transport.js';
import { createPointerLedger } from '../../tabs/pointer.js';

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
for (const read of [2, 3])
  it(`fences reentrant loss in original context read ${read}`, async () => {
    const f = fixture();
    let count = 0;
    f.contexts.mockImplementation(() => {
      if (++count === read) f.revoke();
      return [f.context];
    });
    const failure = await rejected(f.owner.ready);
    expect(failure.value).toMatchObject({ code: 'ENGINE_STOPPED' });
    expect(f.send).not.toHaveBeenCalled();
    if (read === 2) expect(f.create).not.toHaveBeenCalled();
    else expect(f.create).toHaveBeenCalledOnce();
    await expect(f.owner.close()).rejects.toBe(failure.value);
    f.acceptFailure(failure.value);
    expect(f.detach).toHaveBeenCalledTimes(read === 2 ? 0 : 1);
  });
it('does not detach twice after the exact original SDK session close during browser shutdown', async () => {
  const f = fixture();
  await f.owner.ready;
  f.owner.retire();
  f.closed();
  await f.owner.close();
  expect(f.detach).not.toHaveBeenCalled();
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
it('close joins held original send and retains undefined before independent detach failure', async () => {
  let rejectSend!: (reason: unknown) => void;
  const original = new Promise<void>((_resolve, reject) => {
    rejectSend = reject;
  });
  // One pre-acquisition finalizer releases then joins the exact original owner.
  const f = fixture(() => rejectSend(undefined));
  f.send.mockImplementation(() => original);
  f.detach.mockRejectedValue(false);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  let settled = false;
  const closing = f.owner.close();
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  rejectSend(undefined);
  await expect(f.owner.ready).rejects.toBeUndefined();
  await expect(closing).rejects.toBeUndefined();
  f.acceptFailure(undefined);
  expect(f.detach).toHaveBeenCalledOnce();
});

it('focus uses the existing owned input session and survives readiness until original input close', async () => {
  let focused = false;
  const send = vi.fn(async () => {
    focused = true;
  });
  const detach = vi.fn(async () => {
    focused = false;
  });
  const session = { send, detach } as unknown as CDPSession;
  const context = { newCDPSession: vi.fn(async () => session) };
  const page = {
    context: () => context,
    isClosed: () => false,
  } as unknown as Page;
  const original: { owner?: ReturnType<typeof createPageTransport> } = {};
  onTestFinished(async () => {
    await original.owner?.close();
  });
  const owner = createPageTransport({
    preserveFocus: true,
    page,
    current: () => true,
    ordinary: () => true,
    readBinding: () => null,
    retire: () => {},
    pointer: createPointerLedger(() => null),
    cleanup: {
      ordinary: () => true,
      terminal: () => true,
      registerTarget: vi.fn(),
    } as unknown as PageTransportOptions['cleanup'],
  });
  original.owner = owner;
  await owner.ready;
  expect(send).toHaveBeenCalledExactlyOnceWith('Emulation.setFocusEmulationEnabled', {
    enabled: true,
  });
  expect(focused).toBe(true);
  expect(detach).not.toHaveBeenCalled();
  await owner.close();
  expect(detach).toHaveBeenCalledOnce();
  expect(focused).toBe(false);
});

it.each([false, undefined])(
  'joins retained deny cleanup after original Browser.close rejects undefined, even when detach rejects %s',
  async (detachReason) => {
    const f = fixture();
    await f.owner.ready;
    f.detach.mockRejectedValue(detachReason);
    const browser: Pick<Browser, 'close'> = {
      async close() {
        expect(this).toBe(browser);
        expect(f.detach).not.toHaveBeenCalled();
        throw undefined;
      },
    };
    const failure = await rejected(closeBrowserAndDownloads(browser, f.owner));
    expect(failure.value).toBeUndefined();
    expect(f.detach).toHaveBeenCalledOnce();
    await expect(f.owner.close()).rejects.toBe(detachReason);
    f.acceptFailure(detachReason);
  }
);

it('expected exact original Browser disconnect proves parent closure without a child-session close event', async () => {
  const f = fixture();
  await f.owner.ready;
  f.detach.mockRejectedValue(new Error('ALREADY_CLOSED_PARENT_CONNECTION'));
  f.owner.retire();
  f.disconnected();
  await f.owner.close();
  expect(f.detach).not.toHaveBeenCalled();
  expect(f.behavior()).toBe('deny');
  expect(f.lost).not.toHaveBeenCalled();
  expect(f.browserOff).toHaveBeenCalledOnce();
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
it.each([undefined, false])(
  'unobserved parent/session closure cannot qualify an original detach rejection %s',
  async (reason) => {
    const f = fixture();
    await f.owner.ready;
    f.detach.mockRejectedValue(reason);
    const failure = await rejected(f.owner.close());
    f.acceptFailure(reason);
    expect(failure.value).toBe(reason);
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.browserOff).toHaveBeenCalledOnce();
  }
);
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
it('expected parent disconnect does not release held original initialization or its undefined failure', async () => {
  let rejectSend!: (reason: unknown) => void;
  const original = new Promise<void>((_resolve, reject) => {
    rejectSend = reject;
  });
  const f = fixture(() => rejectSend(undefined));
  f.send.mockImplementation(() => original);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  const closing = f.owner.close();
  f.disconnected();
  let settled = false;
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.browserOff).not.toHaveBeenCalled();
  rejectSend(undefined);
  await expect(closing).rejects.toBeUndefined();
  f.acceptFailure(undefined);
  expect(f.detach).not.toHaveBeenCalled();
  expect(f.browserOff).toHaveBeenCalledOnce();
});

it('entered Browser observer registration undefined stays primary while its original remover independently rejects false', async () => {
  let attached = false;
  const remove = vi.fn(() => {
    attached = false;
    throw false;
  });
  const f = fixture(undefined, (browser) => {
    Object.defineProperty(browser, 'on', {
      value: () => {
        attached = true;
        throw undefined;
      },
    });
    Object.defineProperty(browser, 'off', { value: remove });
  });
  const failure = await rejected(f.owner.ready);
  f.acceptFailure(failure.value);
  expect(failure.value).toBeUndefined();
  expect(f.create).not.toHaveBeenCalled();
  expect(attached).toBe(true);
  await expect(f.owner.close()).rejects.toBeUndefined();
  expect(attached).toBe(false);
  expect(remove).toHaveBeenCalledOnce();
});
