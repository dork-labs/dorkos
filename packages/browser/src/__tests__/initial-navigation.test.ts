import { expect, it, vi } from 'vitest';
import type { Frame } from 'playwright-core';
import { tabFixture, configuration, deferred } from './parent-fixture.js';
import { composeInput } from '../lifecycle/input-owner.js';
import { navigateOwnedInitial } from '../lifecycle/initial-navigation.js';
import { currentAuthorityCustody } from '../lifecycle/live-custody.js';
import { submitInput, resetInput } from '../lifecycle/parent-actions.js';

/** Semantic Page callbacks with genuine parent/input owner composition; no native-browser claim. */
async function fixture() {
  const h = tabFixture();
  const config = {
    ...configuration(),
    network: { kind: 'owned' as const, origin: 'about:blank' as const, policyRevision: 1 },
  };
  const peer = Object.freeze({
    url: 'http://127.0.0.1:4901',
    credentials: Object.freeze({ username: 'dorkos', password: 'fixture-only' }),
    isCustodyKnown: () => true,
    close: async () => {},
  });
  h.record.networkPeer = peer;
  h.record.networkCustody = peer.isCustodyKnown;
  h.record.proxy = { url: peer.url, close: async () => {} };
  h.record.directory = {} as NonNullable<typeof h.record.directory>;
  h.record.dataRoot = {} as NonNullable<typeof h.record.dataRoot>;
  let url = 'about:blank';
  const frame = h.page.mainFrame();
  Object.defineProperty(frame, 'url', { value: () => url });
  Object.defineProperty(h.page, 'url', { value: () => url, configurable: true });
  const goto = vi.fn(async (target: string) => {
    const request = {
      isNavigationRequest: () => true,
      frame: () => frame,
      url: () => target,
      method: () => 'GET',
      resourceType: () => 'document',
    };
    h.event('request', request);
    url = target;
    h.event('framenavigated', frame);
    return { request: () => request, url: () => target };
  });
  Object.defineProperty(h.page, 'goto', { value: goto });
  const slot = composeInput(config, h.record, h.tab);
  await slot.readiness;
  const current = () => h.record.lifetime.ordinary.records?.get(h.record.browserId) === h.record;
  const command = {
    kind: 'navigate',
    requestId: h.command().requestId,
    binding: { ...h.tab.binding },
    url: 'http://127.0.0.1:4801/',
  };
  const navigate = (value: unknown = command) =>
    navigateOwnedInitial(config, h.record, current, value);
  const known = () => currentAuthorityCustody(h.record, current);
  const cleanup = async () => {
    h.record.lifetime.requestRetirement('explicitStop');
    await h.record.lifetime.ordinary.retirement.promise;
  };
  return {
    ...h,
    config,
    slot,
    current,
    navigationCommand: command,
    navigate,
    known,
    goto,
    cleanup,
    commit: (target: string) => {
      url = target;
      h.event('framenavigated', frame as Frame);
    },
  };
}
it('advances the canonical first-document binding on the same owned input session and refuses reuse', async () => {
  const f = await fixture();
  expect(f.known()).toBe(true);
  const target = f.slot.registeredTarget;
  const next = await f.navigate();
  expect(next.navigationGeneration).toBe(1);
  expect(f.slot.registeredTarget).toBe(target);
  expect(f.known()).toBe(true);
  await expect(f.navigate({ ...f.navigationCommand, binding: next })).rejects.toThrow();
  expect(f.goto).toHaveBeenCalledOnce();
  expect((await submitInput(f.record, f.command(f.navigationCommand.binding))).outcome).toBe(
    'rejected'
  );
  expect((await submitInput(f.record, f.command(next))).outcome).toBe('completed');
  await f.cleanup();
});
it('fences concurrent input and reset before policy awaits while custody remains known', async () => {
  const f = await fixture(),
    policy = deferred<'allowed'>();
  f.config.policy.authorizeAction = vi.fn(() => policy.promise);
  const navigation = f.navigate();
  expect((await submitInput(f.record, f.command())).outcome).toBe('rejected');
  expect((await resetInput(f.record, f.tab.binding)).status).toBe('stopped');
  expect(f.slot.resetPromise).toBeUndefined();
  expect(f.slot.handle!.hasNeverEnteredInput()).toBe(true);
  expect(f.effects).toEqual([]);
  expect(f.known()).toBe(true);
  policy.resolve('allowed');
  expect((await navigation).navigationGeneration).toBe(1);
  await f.cleanup();
});
it.each(['text', 'keyDown'] as const)(
  'refuses first navigation after an original %s input entered even after native return',
  async (kind) => {
    const f = await fixture();
    const command = {
      ...f.command(),
      steps:
        kind === 'text'
          ? [{ kind: 'text', text: 'completed' }]
          : [{ kind: 'keyDown', key: 'Shift' }],
    };
    expect(
      (await submitInput(f.record, command as Parameters<typeof submitInput>[1])).outcome
    ).toBe('completed');
    expect(f.slot.handle!.hasNeverEnteredInput()).toBe(false);
    await expect(f.navigate()).rejects.toThrow();
    expect(f.goto).not.toHaveBeenCalled();
    await f.cleanup();
  }
);
it('publishes its input fence before Page getters can reenter admission', async () => {
  const f = await fixture();
  let attempted: ReturnType<typeof submitInput> | undefined;
  const read = f.page.url;
  Object.defineProperty(f.page, 'url', {
    get() {
      attempted = submitInput(f.record, f.command());
      return read;
    },
    configurable: true,
  });
  await f.navigate();
  expect((await attempted!).outcome).toBe('rejected');
  expect(f.effects).toEqual([]);
  await f.cleanup();
});
it('refuses competing main-frame commits and never publishes a successful new binding', async () => {
  const f = await fixture();
  f.goto.mockImplementation(async (target: string) => {
    const request = {
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => target,
      method: () => 'GET',
      resourceType: () => 'document',
    };
    f.event('request', request);
    f.commit('http://127.0.0.1:4801/competing');
    return { request: () => request, url: () => target };
  });
  await expect(f.navigate()).rejects.toThrow();
  expect(f.known()).toBe(false);
  await f.cleanup();
});
it('keeps spontaneous navigation on the existing irreversible retirement path', async () => {
  const f = await fixture();
  f.commit('http://127.0.0.1:4801/spontaneous');
  expect(f.known()).toBe(false);
  await expect(f.navigate()).rejects.toThrow();
  expect(f.goto).not.toHaveBeenCalled();
  await f.cleanup();
});
it('rechecks original target retirement after observer cleanup returns normally', async () => {
  const f = await fixture(),
    off = f.page.off;
  Object.defineProperty(f.page, 'off', {
    value: (...args: unknown[]) => {
      if (args[0] === 'request') f.record.lifetime.requestRetirement('authorityRevoked');
      return Reflect.apply(off, f.page, args);
    },
  });
  await expect(f.navigate()).rejects.toThrow();
  expect(f.known()).toBe(false);
  await f.cleanup();
});
it.each([undefined, null, false, 0, ''])(
  'preserves the original falsy failure %j when observer cleanup also fails',
  async (primary) => {
    const f = await fixture();
    f.goto.mockImplementation(async () => {
      throw primary;
    });
    const off = f.page.off;
    Object.defineProperty(f.page, 'off', {
      value: (...args: unknown[]) => {
        if (args[0] === 'request') throw new Error('SECONDARY_OBSERVER_FAILURE');
        return Reflect.apply(off, f.page, args);
      },
    });
    await expect(f.navigate()).rejects.toBe(primary);
    expect(f.record.lifetime.uncertain).toBe(true);
    expect(f.known()).toBe(false);
    await f.cleanup();
  }
);
it('never publishes success when the original goto fails after its observed commit', async () => {
  const f = await fixture(),
    primary = new Error('GOTO_FAILED_AFTER_COMMIT');
  f.goto.mockImplementation(async (target: string) => {
    const request = {
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => target,
      method: () => 'GET',
      resourceType: () => 'document',
    };
    f.event('request', request);
    f.commit(target);
    throw primary;
  });
  await expect(f.navigate()).rejects.toBe(primary);
  expect(f.tab.binding.navigationGeneration).toBe(1);
  expect(f.known()).toBe(false);
  await f.cleanup();
});

it('rechecks target retirement after the original policy signal abort cleanup', async () => {
  const f = await fixture();
  f.config.policy.authorizeAction = async (_binding, signal) => {
    signal.addEventListener(
      'abort',
      () => f.record.lifetime.requestRetirement('authorityRevoked'),
      { once: true }
    );
    return 'allowed';
  };
  await expect(f.navigate()).rejects.toThrow();
  expect(f.known()).toBe(false);
  await f.cleanup();
});
