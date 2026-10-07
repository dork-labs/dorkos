import { expect, it, onTestFinished, vi } from 'vitest';
import type { BrowserLifecycleEngine } from '@dorkos/browser/server-owner';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
import { parseBrowserId, parseTabId, type BrowserBinding } from '@dorkos/browser';
import type { BrowserRegistry } from '../../registry/registry.js';
import { OwnedBrowserController, type BrowserControllerActor } from '../controller.js';

const engineBinding = (value: unknown): BrowserBinding => {
  const binding = BrowserBindingSchema.parse(value);
  return {
    ...binding,
    browserId: parseBrowserId(binding.browserId),
    tabId: parseTabId(binding.tabId),
  };
};

/** Original controller/seat/flow implementation with semantic registry/engine methods;
 * no native, SQLite credential verification or network permission is inferred here. */
function fixture() {
  const state = {
    binding: engineBinding({
      browserId: 'retained-browser-original',
      browserGeneration: 1,
      tabId: 'retained-tab-original-001',
      epoch: 0,
      inputGeneration: 0,
      navigationGeneration: 0,
      viewportVersion: 0,
    }),
    actor: {
      owner: 'original-human-author',
      credential: Object.freeze({}),
      controllerIdentity: Object.freeze({}),
    } as BrowserControllerActor | undefined,
  };
  const originalActor = state.actor!;
  const registry: Pick<BrowserRegistry, 'instance' | 'stop'> = {
    instance(owner, browserId, browserGeneration) {
      if (
        owner !== originalActor.owner ||
        browserId !== state.binding.browserId ||
        browserGeneration !== state.binding.browserGeneration
      )
        throw new Error('FOREIGN_ORIGINAL');
      return {
        browserId,
        browserGeneration,
        mode: 'persistent',
        profileId: 'retained-profile-original',
        status: 'running',
      };
    },
    stop: vi.fn(),
  };
  const reset = vi.fn<BrowserLifecycleEngine['resetInput']>(async (value) => {
    const binding = engineBinding(value);
    state.binding = {
      ...binding,
      epoch: binding.epoch + 1,
      inputGeneration: binding.inputGeneration + 1,
    };
    return { status: 'ready', binding: state.binding };
  });
  const engine: Pick<BrowserLifecycleEngine, 'listTabs' | 'resetInput'> = {
    listTabs: () => [{ ...state.binding }],
    resetInput: reset,
  };
  const controller = new OwnedBrowserController(registry, engine, () => true);
  const operations = new Set<Promise<unknown>>();
  onTestFinished(async () => {
    // All original stops enter before any join, including failed assertion paths.
    const results = await Promise.allSettled([
      controller.closeNavigation(),
      controller.revokeController(originalActor.controllerIdentity),
      ...operations,
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  });
  const own = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.catch(() => {});
    return operation;
  };
  const fenceViews = vi.fn(async () => {});
  controller.bindNavigationViews({ bindingLost: fenceViews });
  const actor = () => state.actor;
  return { state, controller, reset, own, fenceViews, actor, originalActor };
}

it('admits the exact ungranted retained-profile controller and completes its original successor binding', async () => {
  const f = fixture();
  const seat = await f.own(f.controller.takeover(f.actor, f.state.binding));
  const flow = f.controller.captureOwnerNavigation(f.actor, seat.binding);
  await f.own(flow.ready);
  expect(f.fenceViews).toHaveBeenCalledExactlyOnceWith(seat.binding);
  expect(flow.authorization.isCurrent()).toBe(true);
  expect(
    await flow.authorization.authorize(
      engineBinding(seat.binding),
      'https://example.test/',
      new AbortController().signal
    )
  ).toBe('allowed');
  f.state.binding = engineBinding({
    ...seat.binding,
    epoch: seat.binding.epoch + 1,
    inputGeneration: seat.binding.inputGeneration + 1,
    navigationGeneration: seat.binding.navigationGeneration + 1,
  });
  flow.complete(f.state.binding);
  await f.own(flow.close());
  expect(flow.authorization.isCurrent()).toBe(false);
  expect(f.reset).toHaveBeenCalledTimes(1);
});

it('refuses a same-owner replacement controller identity before fencing a retained-profile viewer', async () => {
  const f = fixture();
  const seat = await f.own(f.controller.takeover(f.actor, f.state.binding));
  f.state.actor = { ...f.originalActor, controllerIdentity: Object.freeze({}) };
  expect(() => f.controller.captureOwnerNavigation(f.actor, seat.binding)).toThrow();
  expect(f.fenceViews).not.toHaveBeenCalled();
  expect(f.reset).toHaveBeenCalledTimes(1);
});

it('revokes retained-profile flow permission when the exact original credential is replaced and joins original reset', async () => {
  const f = fixture();
  const seat = await f.own(f.controller.takeover(f.actor, f.state.binding));
  const flow = f.controller.captureOwnerNavigation(f.actor, seat.binding);
  await f.own(flow.ready);
  f.state.actor = { ...f.originalActor, credential: Object.freeze({}) };
  expect(flow.authorization.isCurrent()).toBe(false);
  expect(
    await flow.authorization.authorize(
      engineBinding(seat.binding),
      'https://example.test/',
      new AbortController().signal
    )
  ).toBe('refused');
  await f.own(flow.close());
  expect(f.reset).toHaveBeenCalledTimes(2);
});
