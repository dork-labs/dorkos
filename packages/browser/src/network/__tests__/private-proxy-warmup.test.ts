import { describe, expect, it, vi } from 'vitest';
import { ownPrivateProxyWarmupPage } from '../private-proxy-warmup.js';

const url = 'http://127.0.0.1:43210/private-owned-warm';
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const calls: string[] = [];
  let current = true;
  const response = {
    status: () => 200,
    url: () => url,
    request: () => ({ redirectedFrom: (): unknown => null }),
  };
  const page = {
    goto: vi.fn(async () => {
      calls.push('goto');
      return response;
    }),
    close: vi.fn(async () => {
      calls.push('close');
    }),
  };
  const confirm = vi.fn(async () => {
    calls.push('confirm');
  });
  const pending = new Set<Promise<unknown>>();
  const retain = <T>(enter: () => T | PromiseLike<T>) => {
    const original = Promise.resolve().then(enter);
    pending.add(original);
    void original.finally(() => pending.delete(original)).catch(() => {});
    return original;
  };
  const owner = ownPrivateProxyWarmupPage(page, () => current, retain);
  return {
    owner,
    page,
    response,
    calls,
    confirm,
    pending,
    revoke: () => {
      current = false;
    },
  };
}
describe('original private proxy warm Page', () => {
  it('requires original response and broker completion before joined private close', async () => {
    const f = fixture();
    const confirmation = held<void>();
    const closed = held<void>();
    f.confirm.mockImplementation(() => confirmation.promise);
    f.page.close.mockImplementation(() => closed.promise);
    const work = f.owner.run({ url, confirm: f.confirm });
    void work.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
      expect(f.page.close).not.toHaveBeenCalled();
      confirmation.resolve();
      await vi.waitFor(() => expect(f.page.close).toHaveBeenCalledOnce());
      expect(f.pending.size).toBe(1);
    } finally {
      confirmation.resolve();
      closed.resolve();
      await work;
    }
    expect(f.pending.size).toBe(0);
    expect(f.page.goto).toHaveBeenCalledWith(url, { waitUntil: 'load' });
  });
  it.each([false, undefined])(
    'preserves first original failure %s while joining failed close',
    async (value) => {
      const f = fixture();
      f.confirm.mockRejectedValue(value);
      f.page.close.mockRejectedValue(new Error('close'));
      const work = f.owner.run({ url, confirm: f.confirm });
      await expect(work).rejects.toBe(value);
      expect(f.page.close).toHaveBeenCalledOnce();
      expect(f.pending.size).toBe(0);
    }
  );
  it('refuses revocation after held original response without entering confirmation', async () => {
    const f = fixture();
    const response = held<typeof f.response>();
    f.page.goto.mockImplementation(() => response.promise);
    const work = f.owner.run({ url, confirm: f.confirm });
    void work.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.page.goto).toHaveBeenCalledOnce());
      f.revoke();
    } finally {
      response.resolve(f.response);
      await expect(work).rejects.toThrow('ENGINE_STOPPED');
    }
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.page.close).toHaveBeenCalledOnce();
  });
  it('publishes identical original close before reentrant close and joins once', async () => {
    const f = fixture();
    const returned = held<void>();
    let nested: Promise<void> | undefined;
    f.page.close.mockImplementation(() => {
      nested = f.owner.close();
      return returned.promise;
    });
    const original = f.owner.close();
    try {
      await vi.waitFor(() => expect(nested).toBe(original));
      expect(f.page.close).toHaveBeenCalledOnce();
    } finally {
      returned.resolve();
      await original;
    }
  });
  it.each(['status', 'url', 'redirect'] as const)(
    'rejects wrong original %s before broker confirmation',
    async (field) => {
      const f = fixture();
      if (field === 'status') f.response.status = () => 204;
      if (field === 'url') f.response.url = () => url + '/foreign';
      if (field === 'redirect') f.response.request = () => ({ redirectedFrom: () => ({}) });
      await expect(f.owner.run({ url, confirm: f.confirm })).rejects.toThrow(
        'NETWORK_POLICY_UNSUPPORTED'
      );
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.page.close).toHaveBeenCalledOnce();
    }
  );
});
