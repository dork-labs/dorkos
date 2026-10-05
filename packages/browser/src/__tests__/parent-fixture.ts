import { createTabInput } from '../input/tab-input.js';
import type {
  InputPorts,
  NativeInputTransport,
  NativeInputStep,
  TabInput,
} from '../input/types.js';
import { parseBrowserBinding, type BrowserBinding } from '../contracts.js';
import type { InputOwnerSlot } from '../lifecycle/input-owner.js';
import { cleanupRoute } from '../lifecycle/input-owner.js';
import {
  createEngineInput,
  type EngineTabInput,
  type EngineInputOptions,
} from '../input/engine-input.js';
import type { PageInputCustody } from '../input/page-transport.js';
import type { CloseOutcome } from '../lifecycle/records.js';
import { closeRecord } from '../lifecycle/close.js';
import { sameBinding } from '../input/binding.js';
import { createDiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import { vi, type Mock } from 'vitest';
import type { Page, CDPSession, BrowserContext } from 'playwright-core';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRecord } from '../lifecycle/records.js';
import { parseBrowserId, RequestIdSchema } from '../ids.js';
import {
  bindOrdinaryRecord,
  ordinaryRecord,
  installRetirementDriver,
  createBrowserLifetime,
  fenceOrdinary,
  snapshotRetirementOwners,
} from '../lifecycle/ownership.js';
import { trackPage } from '../tabs/registry.js';
export const requestId = RequestIdSchema.parse('request_subject_A_00000000000000');
export const root = { pid: 41, birth: 'MOCK_ROOT' };
export const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
export function configuration(): EngineConfiguration {
  return {
    dataDir: '/fixture/data',
    runtime: {
      library: {
        package: 'playwright-core',
        version: '1.63.0',
        rootDir: '/fixture/library',
        assets: { manifest: 'browsers.json', cli: 'cli.js' },
      },
      executable: {
        path: '/fixture/chromium',
        sha256: '0'.repeat(64),
        revision: '1243',
        version: '153.0.8010.12',
        platform: 'darwin',
        arch: 'arm64',
      },
      identity: { mode: 'native', policyRevision: 0 },
    },
    network: { kind: 'fixture', origin: 'http://127.0.0.1:9001' },
    clock: { monotonicNow: () => 0, wallNow: () => 1000 },
    processes: {
      descendants: vi.fn(async () => ({ status: 'complete' as const, identities: [root] })),
      observe: vi.fn(async () => ({ status: 'dead' as const })),
    },
    policy: {
      authorizeAction: vi.fn(async () => 'allowed' as const),
      verifyBrokerLease: async () => 'unknown',
    },
  };
}
export function record(status: BrowserRecord['status'] = 'running'): BrowserRecord {
  const browserId = parseBrowserId('browser_subject_A_000000000000000');
  const owned: BrowserRecord = {
    diagnosticsBudget: createDiagnosticsBudget(),
    browserId,
    browserGeneration: 0,
    mode: 'persistent',
    lifetime: createBrowserLifetime(browserId, 0),
    manager: root,
    root,
    rootAttributed: true,
    identities: [],
    inventoryComplete: false,
    launchEntered: true,
    status,
    tabs: new Map(),
    context: { close: vi.fn(async () => {}) } as unknown as BrowserContext,
  };
  registerFixtureRecord(owned, () => closeRecord(configuration(), owned));
  return owned;
}
export function fakePage() {
  const callbacks = new Map<string, Set<(...values: unknown[]) => void>>();
  const effects: string[] = [];
  const action = (name: string): Mock<() => Promise<void>> =>
    vi.fn(async () => {
      effects.push(name);
    });
  const session = { send: action('send'), detach: action('detach') };
  const context: { newCDPSession: Mock<() => Promise<CDPSession>> } = {
    newCDPSession: vi.fn(async () => session as unknown as CDPSession),
  };
  const frame = { url: () => 'http://127.0.0.1:9001/' };
  const page = {
    context: () => context,
    isClosed: () => false,
    mainFrame: () => frame,
    setDefaultTimeout: vi.fn<() => void>(),
    setDefaultNavigationTimeout: vi.fn<() => void>(),
    viewportSize: () => ({ width: 100, height: 80 }),
    screenshot: vi.fn<() => Promise<Uint8Array>>(async (): Promise<Uint8Array> =>
      fakeJPEG(100, 80)
    ),
    mouse: {
      move: action('move'),
      down: action('mouseDown'),
      up: action('mouseUp'),
      wheel: action('wheel'),
    },
    keyboard: { down: action('keyDown'), up: action('keyUp'), insertText: action('text') },
    on: (event: string, callback: (...values: unknown[]) => void) => {
      const set = callbacks.get(event) ?? new Set();
      set.add(callback);
      callbacks.set(event, set);
    },
    off: (event: string, callback: (...values: unknown[]) => void) => {
      callbacks.get(event)?.delete(callback);
    },
    goto: vi.fn<() => Promise<null>>(async () => {
      for (const callback of callbacks.get('framenavigated') ?? []) callback(frame);
      return null;
    }),
    close: action('close'),
  };
  return {
    page: page as unknown as Page,
    raw: page,
    context,
    session,
    effects,
    event: (event: string, value: unknown = frame) => {
      for (const callback of callbacks.get(event) ?? []) callback(value);
    },
  };
}
export function tabFixture(r = record(), now: () => number = () => 0) {
  const p = fakePage();
  const tab = trackPage(r, p.page, 'http://127.0.0.1:9001', now);
  return {
    ...p,
    tab,
    record: r,
    command: (binding = { ...tab.binding }) => ({
      kind: 'input' as const,
      requestId,
      binding,
      steps: [{ kind: 'text' as const, text: 'FIXTURE_CHALLENGE' }],
    }),
  };
}

/** Synthetic baseline header fixture only; it does not certify decoder-valid image content. */
export function fakeJPEG(width = 100, height = 80, marker = 1): Uint8Array {
  return new Uint8Array([
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    marker,
    255,
    217,
  ]);
}

/** Candidate fixture only: actual canonical producer membership, never a request-minted permit. */
export function retirementFixture(owned: BrowserRecord, end: number) {
  const slot = fenceOrdinary(owned, 'authorityRevoked');
  if (!slot) throw new Error('FIXTURE_FENCE_REFUSED');
  snapshotRetirementOwners(owned, slot);
  slot.end = end;
  slot.inputEnd = end;
  return slot;
}

/** Private fixture inputs become complete production-shaped ports only in this mandatory producer. */
export type FixtureInputPorts = Omit<InputPorts, 'cleanup' | 'native'> & {
  native: Omit<NativeInputTransport, 'cleanup'>;
};
type FixtureMember = Readonly<{
  ports: FixtureInputPorts;
  readCanonicalBinding: () => BrowserBinding;
}>;
const fixtureOwners = new WeakMap<TabInput, BrowserRecord>();

/** Bind the exact fixture Map and captured driver before any ordinary observer/factory. */
export function registerFixtureRecord(
  owned: BrowserRecord,
  driver: () => Promise<CloseOutcome>
): void {
  const canonical = new Map([[owned.browserId, owned]]);
  if (
    !bindOrdinaryRecord(owned, canonical) ||
    !installRetirementDriver(owned, () => {
      // The closure is test-owned and returns closeRecord's genuine preregistered Promise.
      const operation = Reflect.apply(driver, undefined, []);
      void operation.catch(() => {
        owned.lifetime.uncertain = true;
      });
    })
  )
    throw new Error('FIXTURE_REGISTRATION_REFUSED');
}

/** Observe a requested retirement before retaining the original terminal-gate assertion. */
export async function settleFixtureRetirement(input: TabInput): Promise<void> {
  const owned = fixtureOwners.get(input);
  if (!owned) throw new Error('FIXTURE_OWNER_UNAVAILABLE');
  if (owned.lifetime.ordinary.phase === 'ordinary') {
    if (!owned.lifetime.gate.stopped) throw new Error('FIXTURE_RETIREMENT_NOT_REQUESTED');
    return; // This exact gate was explicitly stopped by an existing negative fixture.
  }
  await owned.lifetime.ordinary.retirement.promise;
}

/** Single-owner facade of one closed cohort, never a borrowed producer/permit. */
export function createOwnedFixtureInput(
  ports: FixtureInputPorts,
  readCanonicalBinding: () => BrowserBinding
): TabInput {
  return createOwnedFixtureCohort([{ ports, readCanonicalBinding }])[0].input;
}

/** All member slots exist before the first queue observer; peers share one actual local record. */
export function createOwnedFixtureCohort(members: readonly FixtureMember[]) {
  if (members.length === 0) throw new Error('FIXTURE_COHORT_EMPTY');
  const owned = record();
  let constructionDone!: () => void;
  const construction = new Promise<void>((done) => {
    constructionDone = done;
  });
  owned.lifetime.pending.add(construction);
  let initial: readonly Readonly<BrowserBinding>[];
  try {
    initial = members.map((member) => {
      const binding = Object.freeze({ ...member.readCanonicalBinding() });
      if (!ordinaryRecord(owned)) throw new Error('FIXTURE_CONSTRUCTION_RETIRED');
      return binding;
    });
  } catch (error) {
    owned.lifetime.uncertain = true;
    owned.lifetime.requestRetirement('engineFault');
    owned.lifetime.pending.delete(construction);
    constructionDone();
    throw error;
  }
  if (
    initial.some(
      (binding) =>
        binding.browserId !== owned.browserId ||
        binding.browserGeneration !== owned.browserGeneration
    ) ||
    new Set(initial.map((binding) => binding.tabId)).size !== initial.length
  ) {
    owned.lifetime.uncertain = true;
    owned.lifetime.requestRetirement('engineFault');
    owned.lifetime.pending.delete(construction);
    constructionDone();
    throw new Error('FIXTURE_COHORT_IDENTITY_REFUSED');
  }
  // These gates were created by the retained test body. No additional independent gate is borrowed.
  const gate = members[0].ports.stopGate;
  if (members.some((member) => member.ports.stopGate !== gate)) {
    owned.lifetime.uncertain = true;
    owned.lifetime.requestRetirement('engineFault');
    owned.lifetime.pending.delete(construction);
    constructionDone();
    throw new Error('FIXTURE_COHORT_GATE_REFUSED');
  }
  owned.lifetime = { ...owned.lifetime, gate };
  const prepared = members.map((member, index) => {
    const h = tabFixture(owned),
      oldId = h.tab.binding.tabId;
    owned.tabs.delete(oldId);
    h.tab.binding = initial[index];
    owned.tabs.set(h.tab.binding.tabId, h.tab);
    let constructed!: () => void;
    const slot: InputOwnerSlot = {
      tab: h.tab,
      page: h.page,
      constructed: new Promise((done) => {
        constructed = done;
      }),
      constructing: true,
      ready: false,
      uncertain: false,
      closePending: false,
    };
    owned.lifetime.inputs.set(h.tab, slot);
    return { member, h, slot, constructed };
  });
  owned.lifetime.pending.delete(construction);
  constructionDone();
  return prepared.map(({ member, h, slot, constructed }) => {
    const route = cleanupRoute(owned, slot),
      session = h.session;
    const source = member.ports;
    let queue!: TabInput;
    let nativePending = 0,
      closed = false,
      closePromise: Promise<PageInputCustody> | undefined;
    const exact = (binding: BrowserBinding): boolean =>
      h.tab.page === slot.page &&
      owned.tabs.get(binding.tabId) === h.tab &&
      owned.lifetime.inputs.get(h.tab) === slot &&
      sameBinding(h.tab.binding, binding);
    const refresh = (): BrowserBinding => {
      const observed = member.readCanonicalBinding();
      h.tab.binding = Object.freeze({ ...observed });
      return h.tab.binding;
    };
    const closedBinding = (value: unknown): BrowserBinding => {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('FIXTURE_CANONICAL_OBSERVATION_REFUSED');
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('FIXTURE_CANONICAL_OBSERVATION_REFUSED');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const fields = [
        'browserId',
        'browserGeneration',
        'tabId',
        'epoch',
        'inputGeneration',
        'navigationGeneration',
        'viewportVersion',
      ] as const;
      if (Reflect.ownKeys(descriptors).length !== fields.length)
        throw new Error('FIXTURE_CANONICAL_OBSERVATION_REFUSED');
      const copy: Record<string, unknown> = {};
      for (const field of fields) {
        const descriptor = descriptors[field];
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
          throw new Error('FIXTURE_CANONICAL_OBSERVATION_REFUSED');
        copy[field] = descriptor.value;
      }
      return Object.freeze(parseBrowserBinding(copy));
    };
    const observeCaller = (): BrowserBinding => {
      // Observe the genuine mutable caller port, preserving its exact receiver.
      const read = source.readBinding;
      if (typeof read !== 'function') throw new Error('FIXTURE_CANONICAL_OBSERVATION_REFUSED');
      return closedBinding(Reflect.apply(read, source, []));
    };
    const ordinaryGuard = (binding: BrowserBinding, signal: AbortSignal): void => {
      const observed = observeCaller();
      // Observation/reflection can reenter: private correspondence follows, never mirror refresh.
      if (!sameBinding(observed, binding) || signal.aborted || !route.ordinary() || !exact(binding))
        throw new Error('FIXTURE_NATIVE_TARGET_REFUSED');
    };
    const started = new Set<{ binding: BrowserBinding; entered: boolean }>();
    const operation = (
      enter: (guard: () => void, markEntered: () => void) => Promise<void>,
      binding: BrowserBinding,
      guard: () => void,
      cleanup = false
    ): Promise<void> => {
      const attribution = { binding, entered: false };
      started.add(attribution);
      nativePending++;
      let acknowledge!: () => void, refuse!: (error: unknown) => void;
      const pending = new Promise<void>((done, fail) => {
        acknowledge = done;
        refuse = fail;
      });
      try {
        guard();
        const native = enter(guard, () => {
          attribution.entered = true;
        });
        void Promise.resolve(native).then(
          () => {
            nativePending--;
            started.delete(attribution);
            try {
              const observed = observeCaller();
              const current = h.tab.binding;
              // Proposed strict7 policy: reset cannot promote a started old request
              // into new authority. Actual native completion only releases custody;
              // stale command success remains refused and keeps the stopped outcome.
              const acknowledgedBinding = sameBinding(current, binding) ? binding : null;
              if (
                !acknowledgedBinding ||
                !sameBinding(observed, acknowledgedBinding) ||
                !(cleanup ? route.retiring() : route.ordinary()) ||
                !exact(acknowledgedBinding) ||
                !route.settlement(acknowledgedBinding, transport, session, slot.page)
              )
                throw new Error('FIXTURE_ACK_TARGET_REFUSED');
              acknowledge();
            } catch (error) {
              slot.uncertain = true;
              refuse(error);
            }
          },
          (error: unknown) => {
            nativePending--;
            started.delete(attribution);
            slot.uncertain = true;
            refuse(error);
          }
        );
      } catch (error) {
        nativePending--;
        started.delete(attribution);
        slot.uncertain = true;
        refuse(error);
      }
      return pending;
    };
    const captureCall = (
      kind: 'dispatch' | 'cancelComposition' | 'cancelDrag',
      step: NativeInputStep | null,
      signal: AbortSignal,
      guard: () => void,
      markEntered: () => void
    ) => {
      const receiver = source.native;
      const call = receiver[kind];
      guard();
      markEntered();
      return kind === 'dispatch'
        ? (Reflect.apply(call, receiver, [step!, signal]) as Promise<void>)
        : (Reflect.apply(call, receiver, [signal]) as Promise<void>);
    };
    const transport: NativeInputTransport = {
      dispatch: (step, signal) => {
        const binding = closedBinding(h.tab.binding);
        return operation(
          (guard, mark) => captureCall('dispatch', step, signal, guard, mark),
          binding,
          () => ordinaryGuard(binding, signal)
        );
      },
      cancelComposition: (signal) => {
        const binding = closedBinding(h.tab.binding);
        return operation(
          (guard, mark) => captureCall('cancelComposition', null, signal, guard, mark),
          binding,
          () => ordinaryGuard(binding, signal)
        );
      },
      cancelDrag: (signal) => {
        const binding = closedBinding(h.tab.binding);
        return operation(
          (guard, mark) => captureCall('cancelDrag', null, signal, guard, mark),
          binding,
          () => ordinaryGuard(binding, signal)
        );
      },
      cleanup: (permit, attempt, signal) => {
        if (!route.enter(permit, attempt))
          return Promise.reject(new Error('FIXTURE_PERMIT_REFUSED'));
        const binding = route.binding();
        if (!binding) return Promise.reject(new Error('FIXTURE_BINDING_UNAVAILABLE'));
        const guard = () => {
          // Fallible caller observation precedes the genuine producer's final clock/private fence.
          const observed = observeCaller();
          if (
            !sameBinding(observed, binding) ||
            !exact(binding) ||
            signal.aborted ||
            !route.retiring() ||
            !exact(binding) ||
            !route.allows(permit, binding, transport, session, slot.page)
          )
            throw new Error('FIXTURE_CLEANUP_TARGET_REFUSED');
        };
        return operation(
          (verify, mark) => {
            const step = attempt.step;
            if (step.kind === 'cancelComposition')
              return captureCall('cancelComposition', null, signal, verify, mark);
            if (step.kind === 'cancelDrag')
              return captureCall('cancelDrag', null, signal, verify, mark);
            return captureCall('dispatch', step, signal, verify, mark);
          },
          binding,
          guard,
          true
        );
      },
    };
    const custody = (): PageInputCustody =>
      Object.freeze({
        acquisitionPending: false,
        nativePending,
        detachPending: false,
        detached: closed,
        uncertain: slot.uncertain,
      });
    const handle: EngineTabInput = Object.freeze({
      ready: Promise.resolve(),
      submit: (command: unknown, signal?: AbortSignal) => queue.submit(command, signal),
      reset: () => queue.reset(),
      retire: (end: number) => queue.retire(end),
      // Queue-only fixtures do not acquire an original Page transport session.
      isCustodyKnown: () => false,
      custody,
      close: () => {
        if (!route.terminal()) {
          route.requestRetirement('explicitStop');
          return Promise.reject(new Error('FIXTURE_TERMINAL_NOT_ENTERED'));
        }
        closePromise ??= Promise.resolve().then(async () => {
          if (!queue) {
            slot.uncertain = true;
            throw new Error('FIXTURE_QUEUE_UNAVAILABLE');
          }
          const detach = session.detach;
          await Reflect.apply(detach, session, []);
          closed = true;
          return custody();
        });
        return closePromise;
      },
    });
    slot.handle = handle;
    slot.retireOwner = (end) => Reflect.apply(handle.retire, handle, [end]);
    try {
      route.registerTarget(slot.page, transport, session);
      queue = createTabInput({
        cleanup: route,
        native: transport,
        stopGate: gate,
        readBinding: () => {
          refresh();
          const read = source.readBinding;
          return Reflect.apply(read, source, []);
        },
        publishResetBinding: (binding) => {
          const before = refresh();
          const publish = source.publishResetBinding;
          if (!route.ordinary() || !sameBinding(h.tab.binding, before))
            throw new Error('FIXTURE_PUBLICATION_REFUSED');
          Reflect.apply(publish, source, [binding]);
          if (!sameBinding(refresh(), binding) || !route.ordinary())
            throw new Error('FIXTURE_PUBLICATION_REFUSED');
        },
        authorize: (binding, step, signal) => {
          const authorize = source.authorize;
          return Reflect.apply(authorize, source, [binding, step, signal]);
        },
      });
      if (!route.ordinary() || !exact(h.tab.binding))
        throw new Error('FIXTURE_READY_TARGET_REFUSED');
      slot.ready = true;
      fixtureOwners.set(queue, owned);
    } catch (error) {
      slot.uncertain = true;
      route.requestRetirement('engineFault');
      throw error;
    } finally {
      slot.constructing = false;
      constructed();
    }
    return Object.freeze({
      input: queue,
      record: owned,
      tab: h.tab,
      page: slot.page,
      transport,
      session,
      slot,
      fixture: h,
    });
  });
}

/** Test-owned canonical composition. Its genuine driver and slot precede every Page observation. */
export function createOwnedFixtureEngineInput(options: Omit<EngineInputOptions, 'cleanup'>) {
  const owned = record();
  let constructed!: () => void;
  const construction = new Promise<void>((done) => {
    constructed = done;
  });
  owned.lifetime.pending.add(construction);
  let slot: InputOwnerSlot | undefined;
  try {
    const tab = options.tab;
    if (
      tab.binding.browserId !== owned.browserId ||
      tab.binding.browserGeneration !== owned.browserGeneration ||
      !ordinaryRecord(owned)
    )
      throw new Error('FIXTURE_ENGINE_IDENTITY_REFUSED');
    owned.lifetime = { ...owned.lifetime, gate: options.stopGate };
    owned.tabs.set(tab.binding.tabId, tab);
    slot = {
      tab,
      page: tab.page,
      constructed: construction,
      constructing: true,
      ready: false,
      uncertain: false,
      closePending: false,
    };
    owned.lifetime.inputs.set(tab, slot);
    const input = createEngineInput({ ...options, cleanup: cleanupRoute(owned, slot) });
    slot.handle = input;
    const retire = input.retire;
    slot.retireOwner = (end) => Reflect.apply(retire, input, [end]);
    slot.constructing = false;
    const capturedSlot = slot;
    capturedSlot.readiness = input.ready
      .then(() => {
        if (
          !ordinaryRecord(owned) ||
          owned.lifetime.inputs.get(tab) !== capturedSlot ||
          owned.tabs.get(tab.binding.tabId) !== tab ||
          owned.lifetime.gate.stopped
        )
          throw new Error('FIXTURE_ENGINE_READY_REFUSED');
        capturedSlot.ready = true;
      })
      .catch((error: unknown) => {
        capturedSlot.uncertain = true;
        owned.lifetime.requestRetirement('engineFault');
        throw error;
      });
    void capturedSlot.readiness.catch(() => {});
    let parentWait: Promise<PageInputCustody> | undefined;
    const close = (end?: number): Promise<PageInputCustody> => {
      if (parentWait) return parentWait;
      let resolve!: (custody: PageInputCustody) => void;
      let reject!: (error: unknown) => void;
      parentWait = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      // Published before the real parent's clock/retirement callbacks; its fixed end is not renewed.
      void closeRecord(configuration(), owned, end).then(() => {
        const childClose = capturedSlot.closePromise;
        if (!childClose) {
          reject(new Error('FIXTURE_CHILD_CLOSE_UNAVAILABLE'));
          return;
        }
        void childClose.then(resolve, reject);
      }, reject);
      return parentWait;
    };
    return Object.freeze({ input, record: owned, tab, slot: capturedSlot, close });
  } catch (error) {
    if (slot) {
      slot.constructing = false;
      slot.uncertain = true;
    }
    owned.lifetime.uncertain = true;
    owned.lifetime.requestRetirement('engineFault');
    throw error;
  } finally {
    owned.lifetime.pending.delete(construction);
    constructed();
  }
}
