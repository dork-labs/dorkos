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
function fixture(
  options?: Readonly<{
    expectedFailure: unknown;
    inputRetirement?: NonNullable<BrowserLifecycleEngine['captureInputRetirement']>;
  }>
) {
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
  const readTabs = vi.fn<BrowserLifecycleEngine['listTabs']>(() => [{ ...state.binding }]);
  const engine: Pick<BrowserLifecycleEngine, 'listTabs' | 'resetInput' | 'captureInputRetirement'> =
    {
      listTabs: readTabs,
      resetInput: reset,
      captureInputRetirement: options?.inputRetirement,
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
    if (rejected?.status === 'rejected') {
      if (options) expect(rejected.reason).toBe(options.expectedFailure);
      else throw rejected.reason;
    }
  });
  const own = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.catch(() => {});
    return operation;
  };
  const fenceViews = vi.fn(async () => {});
  controller.bindNavigationViews({ bindingLost: fenceViews });
  const actor = () => state.actor;
  return { state, controller, reset, readTabs, own, fenceViews, actor, originalActor };
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

it.each([false, undefined])(
  'joins one original Seat loss through navigation reentry and preserves %s after engine stop',
  async (cause) => {
    const f = fixture({ expectedFailure: cause });
    const seat = await f.own(f.controller.takeover(f.actor, f.state.binding));
    const flow = f.controller.captureOwnerNavigation(f.actor, seat.binding);
    await f.own(flow.ready);
    let reject!: (value: unknown) => void;
    const held = new Promise<Awaited<ReturnType<BrowserLifecycleEngine['resetInput']>>>(
      (_yes, no) => {
        reject = no;
      }
    );
    void held.catch(() => {});
    f.reset.mockImplementation(() => held);
    const operations: Promise<unknown>[] = [];
    let settled = false;
    try {
      const first = f.own(f.controller.revokeController(f.originalActor.controllerIdentity));
      operations.push(first);
      void first.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      const repeated = f.own(f.controller.revokeController(f.originalActor.controllerIdentity));
      operations.push(repeated);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.reset).toHaveBeenCalledTimes(2); // Original takeover, then one original loss.
      expect(settled).toBe(false);
      expect(f.controller.pendingResets()).toBe(1);
      const reads = f.readTabs.mock.calls.length;
      reject(cause);
      for (const operation of operations) {
        const result = await Promise.allSettled([operation]);
        expect(result).toEqual([{ status: 'rejected', reason: cause }]);
      }
      const stopped = new Error('BROWSER_STOPPED');
      f.readTabs.mockImplementation(() => {
        throw stopped;
      });
      const later = f.own(f.controller.revokeController(f.originalActor.controllerIdentity));
      operations.push(later);
      expect(await Promise.allSettled([later])).toEqual([{ status: 'rejected', reason: cause }]);
      expect(f.readTabs).toHaveBeenCalledTimes(reads);
      expect(f.reset).toHaveBeenCalledTimes(2);
      expect(f.controller.pendingResets()).toBe(0);
      expect(await Promise.allSettled([f.own(flow.close())])).toEqual([
        { status: 'rejected', reason: cause },
      ]);
    } finally {
      reject(cause);
      await Promise.allSettled([held, ...operations, f.own(flow.close())]);
    }
  }
);

it.each(['settled', 'unverified', 'foreign', false, undefined] as const)(
  'joins held original input retirement instead of enumerating the stopped engine: %s',
  async (outcome) => {
    type Observation = NonNullable<
      Awaited<
        ReturnType<
          ReturnType<
            NonNullable<BrowserLifecycleEngine['captureInputRetirement']>
          >['joinIfRetiring']
        >
      >
    >;
    let resolve!: (value: Observation) => void, reject!: (value: unknown) => void;
    const original = new Promise<Observation>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void original.catch(() => {});
    let retiring = false;
    const join = vi.fn(() => (retiring ? original : undefined));
    const capture = vi.fn(() => Object.freeze({ joinIfRetiring: join }));
    const options: {
      expectedFailure: unknown;
      inputRetirement: NonNullable<BrowserLifecycleEngine['captureInputRetirement']>;
    } = { expectedFailure: outcome === 'settled' ? undefined : outcome, inputRetirement: capture };
    const f = fixture(options);
    const jobs: Promise<unknown>[] = [];
    try {
      const seat = await f.own(f.controller.takeover(f.actor, f.state.binding));
      const flow = f.controller.captureOwnerNavigation(f.actor, seat.binding);
      await f.own(flow.ready);
      retiring = true;
      f.readTabs.mockImplementation(() => {
        throw new Error('BROWSER_STOPPED');
      });
      const reads = f.readTabs.mock.calls.length;
      const resets = f.reset.mock.calls.length;
      let returned = false;
      const loss = f.own(f.controller.revokeController(f.originalActor.controllerIdentity));
      jobs.push(loss);
      void loss.then(
        () => {
          returned = true;
        },
        () => {
          returned = true;
        }
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(returned).toBe(false);
      expect(f.readTabs).toHaveBeenCalledTimes(reads);
      expect(f.reset).toHaveBeenCalledTimes(resets);
      expect(capture).toHaveBeenCalledTimes(1);
      if (outcome === 'settled') {
        resolve({
          state: 'settled',
          binding: f.state.binding,
          drain: 'acknowledged',
          release: 'acknowledged',
          pending: false,
          uncertainty: false,
        });
        await loss;
      } else if (outcome === 'unverified' || outcome === 'foreign') {
        resolve(
          outcome === 'unverified'
            ? {
                state: 'unverified',
                binding: null,
                reason: 'observationUnavailable',
                pending: true,
                uncertainty: true,
              }
            : {
                state: 'settled',
                binding: {
                  ...f.state.binding,
                  browserGeneration: f.state.binding.browserGeneration + 1,
                },
                drain: 'acknowledged',
                release: 'acknowledged',
                pending: false,
                uncertainty: false,
              }
        );
        const result = await Promise.allSettled([loss]);
        expect(result[0]).toMatchObject({ status: 'rejected', reason: { reason: 'inaccessible' } });
        if (result[0].status !== 'rejected') throw new Error('ORIGINAL_LOSS_NOT_REFUSED');
        options.expectedFailure = result[0].reason;
      } else {
        reject(outcome);
        expect(await Promise.allSettled([loss])).toEqual([{ status: 'rejected', reason: outcome }]);
      }
      jobs.push(f.own(flow.close()));
      const closed = await Promise.allSettled(jobs);
      expect(
        closed.every((row) =>
          outcome === 'settled'
            ? row.status === 'fulfilled'
            : row.status === 'rejected' && row.reason === options.expectedFailure
        )
      ).toBe(true);
    } finally {
      reject(outcome);
      await Promise.allSettled([original, ...jobs]);
    }
  }
);
