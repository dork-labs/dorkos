import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountAdvisor, LimitedSessionInfo, SessionInfo } from '@dorkos/extension-api/server';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { AccountUsageStore } from '../../core/usage/account-usage-store.js';
import * as advisorHost from '../../core/usage/account-advisor.js';
import * as usageHost from '../../core/usage/current-usage-store.js';
import { createDataProviderContext } from '../extension-server-api-factory.js';
import { RegistrationCustody } from '../server-lifecycle/registration-custody.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const context = {
  purpose: 'launch',
  caller: 'agent',
  cwd: '/repo',
  runtime: 'claude-code',
} as const;
const ranking = { accounts: [], recommendedId: null };
let home: string;
type OwnedContext = ReturnType<typeof createDataProviderContext> & {
  bank: RegistrationCustody;
  occurrence: ReturnType<RegistrationCustody['begin']>;
};
const owners: OwnedContext[] = [];

function fixture(): OwnedContext {
  const bank = new RegistrationCustody();
  const occurrence = bank.begin('owned');
  const built = createDataProviderContext({
    extensionId: 'owned',
    extensionDir: home,
    dorkHome: home,
    requireCurrent: () => occurrence.requireCurrent(),
    ownOriginal: (enter) => occurrence.runOriginal(enter),
  });
  const owned = { ...built, bank, occurrence };
  owners.push(owned);
  return owned;
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'accounts-occurrence-'));
  advisorHost.__resetAccountAdvisorForTests();
});
afterEach(async () => {
  const owned = owners.splice(0);
  // retire([]) is memoized: explicitly enter original dispose even when an earlier test retired first.
  const disposed = owned.map(async (f) => {
    f.dispose();
  });
  const closing = owned.map((f) => f.occurrence.retire([]));
  await Promise.allSettled([...disposed, ...closing]);
  advisorHost.__resetAccountAdvisorForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(home, { recursive: true, force: true });
});

function originalUsagePort() {
  const listeners = new Set<(usage: AccountUsage) => void>();
  const remove = vi.fn();
  const store = {
    onChange(listener: (usage: AccountUsage) => void) {
      listeners.add(listener);
      return () => {
        remove();
        listeners.delete(listener);
      };
    },
  };
  vi.spyOn(usageHost, 'getAccountUsageStore').mockReturnValue(
    store as unknown as AccountUsageStore
  );
  return { listeners, remove };
}

function capturedAdvisor(f: ReturnType<typeof fixture>, original: AccountAdvisor): AccountAdvisor {
  const register = vi.spyOn(advisorHost, 'registerAccountAdvisor');
  f.ctx.accounts.registerAdvisor(original);
  const captured = register.mock.calls[0]?.[1];
  if (!captured) throw new Error('Original advisor registration did not enter.');
  return captured;
}

describe('original account callback occurrence', () => {
  it('delivers current usage but refuses a retained old callback before dispose', async () => {
    const port = originalUsagePort();
    const f = fixture();
    const listener = vi.fn();
    f.ctx.accounts.onUsage(listener);
    const callback = [...port.listeners][0];
    if (!callback) throw new Error('Original usage callback was not retained.');
    const usage = {
      runtime: 'claude-code',
      accountId: 'work',
      path: '/private/account',
    } as AccountUsage;
    callback(usage);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).not.toHaveProperty('path');
    // An original host iteration may retain this callback after the removable Set entry is gone.
    await f.occurrence.retire([]);
    callback(usage);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(port.remove).not.toHaveBeenCalled();
    f.dispose();
    expect(port.remove).toHaveBeenCalledTimes(1);
  });

  it('joins an original async usage callback while preserving its exact returned promise', async () => {
    const port = originalUsagePort();
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listener = vi.fn(() => gate);
    f.ctx.accounts.onUsage(listener);
    const callback = [...port.listeners][0];
    if (!callback) throw new Error('Original usage callback was not retained.');
    const usage = {
      runtime: 'claude-code',
      accountId: 'work',
      path: '/private/account',
    } as AccountUsage;
    expect(callback(usage)).toBe(gate);
    let closed = false;
    const closing = f.occurrence.retire([f.dispose]);
    void closing.then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(f.bank.permits('owned')).toBe(false);
      expect(callback(usage)).toBeUndefined();
      expect(listener).toHaveBeenCalledTimes(1);
      release();
      await closing;
      expect(f.bank.permits('owned')).toBe(true);
    } finally {
      release();
      await Promise.allSettled([gate, closing]);
    }
  });

  it.each([false, undefined])('retains a synchronous usage callback failure %s', (value) => {
    const port = originalUsagePort();
    const f = fixture();
    f.ctx.accounts.onUsage(() => {
      throw value;
    });
    const callback = [...port.listeners][0];
    if (!callback) throw new Error('Original usage callback was not retained.');
    let caught: { value: unknown } | undefined;
    try {
      callback({ runtime: 'claude-code', accountId: 'work' } as AccountUsage);
    } catch (cause) {
      caught = { value: cause };
    }
    expect(caught).toEqual({ value });
  });

  it('refuses old registration without replacing a newer same-ID advisor', async () => {
    const old = fixture();
    await old.occurrence.retire([]);
    const current = fixture();
    const rank = vi.fn(() => ranking);
    current.ctx.accounts.registerAdvisor({ rank });
    expect(() => old.ctx.accounts.registerAdvisor({ rank: () => ranking })).toThrow('retired');
    expect(await advisorHost.callAdvisor('rank', [], context)).toBe(ranking);
    expect(rank).toHaveBeenCalledTimes(1);
    old.dispose();
    expect(advisorHost.accountAdvisorOwner()).toBe('owned');
  });

  it('retains the original advisor receiver and refuses core invocation after retirement', async () => {
    const f = fixture();
    const rank = vi.fn(() => ranking);
    const original: AccountAdvisor = { rank };
    f.ctx.accounts.registerAdvisor(original);
    expect(await advisorHost.callAdvisor('rank', [], context)).toBe(ranking);
    expect(rank.mock.contexts).toHaveLength(1);
    expect(rank.mock.contexts[0]).toBe(original);
    await f.occurrence.retire([]);
    expect(await advisorHost.callAdvisor('rank', [], context)).toBeUndefined();
    expect(rank).toHaveBeenCalledTimes(1);
  });

  it('joins entered original rank and withholds its successful answer after retirement', async () => {
    const f = fixture();
    let release!: (value: typeof ranking) => void;
    const gate = new Promise<typeof ranking>((resolve) => {
      release = resolve;
    });
    const rank = vi.fn(() => gate);
    const captured = capturedAdvisor(f, { rank });
    const original = captured.rank([], context);
    const observed = Promise.resolve(original).then(
      () => ({ ok: true }),
      (value) => ({ value })
    );
    let closed = false;
    const closing = f.occurrence.retire([f.dispose]);
    void closing.then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(rank).toHaveBeenCalledTimes(1);
      expect(closed).toBe(false);
      expect(f.bank.permits('owned')).toBe(false);
      release(ranking);
      expect(await observed).toEqual({
        value: expect.objectContaining({ message: expect.stringContaining('retired') }),
      });
      await closing;
      expect(f.bank.permits('owned')).toBe(true);
    } finally {
      release(ranking);
      await Promise.allSettled([original, closing]);
    }
  });

  it('keeps actual advisor work held after the original core timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: typeof ranking) => void;
    const gate = new Promise<typeof ranking>((resolve) => {
      release = resolve;
    });
    const rank = vi.fn(() => gate);
    f.ctx.accounts.registerAdvisor({ rank });
    const original = advisorHost.callAdvisor('rank', [], context);
    for (let i = 0; i < 8 && rank.mock.calls.length === 0; i++) await Promise.resolve();
    let closed = false;
    const closing = f.occurrence.retire([f.dispose]);
    void closing.then(() => {
      closed = true;
    });
    try {
      expect(rank).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(advisorHost.ADVISOR_TIMEOUT_MS);
      expect(await original).toBeUndefined();
      expect(closed).toBe(false);
      expect(f.bank.permits('owned')).toBe(false);
      release(ranking);
      await closing;
      expect(f.bank.permits('owned')).toBe(true);
    } finally {
      release(ranking);
      await Promise.allSettled([original, closing]);
    }
  });

  it.each([false, undefined])(
    'guards reentrant method capture before original registration %s',
    async (value) => {
      const f = fixture();
      const register = vi.spyOn(advisorHost, 'registerAccountAdvisor');
      const nextGetter = vi.fn(() => undefined);
      const original: AccountAdvisor = {
        rank: () => ranking,
        get onLimited() {
          f.occurrence.fail(value);
          return undefined;
        },
        get modelFallback() {
          return nextGetter();
        },
      };
      let caught: { value: unknown } | undefined;
      try {
        f.ctx.accounts.registerAdvisor(original);
      } catch (cause) {
        caught = { value: cause };
      }
      expect(caught).toEqual({ value });
      expect(register).not.toHaveBeenCalled();
      expect(nextGetter).not.toHaveBeenCalled();
      expect(advisorHost.hasAccountAdvisor()).toBe(false);
    }
  );

  it('preserves malformed-rank validation without a second hostile getter entry', () => {
    const f = fixture();
    let reads = 0;
    const original = {
      get rank() {
        reads++;
        if (reads === 1) return undefined;
        void f.occurrence.retire([]);
        return () => ranking;
      },
    } as unknown as AccountAdvisor;
    expect(() => f.ctx.accounts.registerAdvisor(original)).toThrow('needs a rank');
    expect(reads).toBe(1);
    expect(advisorHost.hasAccountAdvisor()).toBe(false);
  });

  it.each([false, undefined])(
    'keeps exact original advisor failure %s despite retirement',
    async (value) => {
      const f = fixture();
      let reject!: (value: unknown) => void;
      const gate = new Promise<typeof ranking>((_resolve, no) => {
        reject = no;
      });
      const captured = capturedAdvisor(f, { rank: () => gate });
      const original = captured.rank([], context);
      const observed = Promise.resolve(original).then(
        () => ({ ok: true }),
        (cause) => ({ value: cause })
      );
      const closing = f.occurrence.retire([f.dispose]);
      try {
        reject(value);
        expect(await observed).toEqual({ value });
        await closing;
      } finally {
        reject(value);
        await Promise.allSettled([original, closing]);
      }
    }
  );

  it('captures optional original methods and guards each before entry', async () => {
    const f = fixture();
    const methods = {
      onLimited: vi.fn(() => ({ mode: 'ask' as const })),
      modelFallback: vi.fn(() => null),
      carryOver: vi.fn(() => ({ seedContext: 'seed' })),
      claims: vi.fn(() => true),
      move: vi.fn(),
      cancelAuto: vi.fn(),
      wait: vi.fn(),
    };
    const captured = capturedAdvisor(f, { rank: () => ranking, ...methods });
    const info: SessionInfo = {
      sessionId: 's',
      cwd: '/repo',
      runtime: 'claude-code',
      accountId: 'work',
      trackerItems: [],
    };
    const limited: LimitedSessionInfo = {
      sessionId: 's',
      cwd: '/repo',
      accountId: 'work',
      window: 'seven_day',
      resetsAt: null,
      scope: 'account',
      model: null,
      trackerItems: [],
    };
    const calls = [
      () => captured.onLimited?.(limited),
      () => captured.modelFallback?.(limited),
      () => captured.carryOver?.(limited, 'next'),
      () => captured.claims?.(info),
      () => captured.move?.(info, { runtime: 'claude-code', accountId: 'next' }),
      () => captured.cancelAuto?.(info),
      () => captured.wait?.(info, null, false),
    ];
    for (const enter of calls) await enter();
    for (const method of Object.values(methods)) expect(method).toHaveBeenCalledTimes(1);
    await f.occurrence.retire([]);
    for (const enter of calls) await expect(enter()).rejects.toThrow('retired');
    for (const method of Object.values(methods)) expect(method).toHaveBeenCalledTimes(1);
  });
});
