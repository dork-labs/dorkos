import type { EffectOwner } from '@/layers/shared/lib';
/** Private host entry bound to exactly one loader lifetime. */
export interface HostEntry {
  call: <Args extends unknown[], Result>(
    target: object,
    method: (...args: Args) => Result,
    args: Args
  ) => Result;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  effectOwner: EffectOwner;
}
/** Arguments and methods are captured before the final owner check. */
export function createHostEntry(
  requireCurrent: () => void,
  cleanups: Array<() => void>
): HostEntry {
  const call: HostEntry['call'] = (target, method, args) => {
    requireCurrent();
    return Reflect.apply(method, target, args);
  };
  const fetch: HostEntry['fetch'] = (url, init) => {
    const method = globalThis.fetch;
    return call(globalThis, method, [url, init]);
  };
  const effectOwner: EffectOwner = Object.freeze({
    beforeEffect: requireCurrent,
    registerCleanup: (cleanup: () => void) => {
      cleanups.push(cleanup);
    },
  });
  return { call, fetch, effectOwner };
}

const commandSlots = new WeakMap<object, Map<string, object>>();
/** Capture a cleanup for one entered command occurrence, never a later same-ID replacement. */
export function prepareCommandRegistration(
  target: {
    registerCommandHandler: (id: string, callback: () => void) => void;
    unregisterCommandHandler: (id: string) => void;
  },
  id: string,
  callback: () => void
): { enter: () => void; cleanup: () => void } {
  const register = target.registerCommandHandler;
  const remove = target.unregisterCommandHandler;
  let slots = commandSlots.get(target);
  if (!slots) commandSlots.set(target, (slots = new Map()));
  const occurrence = {};
  let entered = false;
  return {
    enter: () => {
      slots.set(id, occurrence);
      entered = true;
      Reflect.apply(register, target, [id, callback]);
    },
    cleanup: retainCleanup(() => {
      if (!entered) return;
      if (slots.get(id) !== occurrence) return;
      slots.delete(id);
      return Reflect.apply(remove, target, [id]);
    }),
  };
}
const contributionSlots = new WeakMap<object, Map<string, Map<string, object>>>();
/** Retain an idempotent original contribution receipt with callback-free slot correspondence. */
export function enterContribution(
  target: object,
  method: (slot: string, contribution: { id: string }) => () => void,
  input: {
    slot: string;
    contribution: { id: string };
    requireCurrent: () => void;
    track: (cleanup: () => void) => void;
  }
): () => void {
  const { slot, contribution, requireCurrent, track } = input;
  const id = contribution.id;
  let all = contributionSlots.get(target);
  if (!all) contributionSlots.set(target, (all = new Map()));
  let slots = all.get(slot);
  if (!slots) all.set(slot, (slots = new Map()));
  const occurrence = {};
  let entered = false;
  const receipt: { remove?: () => void } = {};
  const cleanup = retainCleanup(() => {
    if (!entered) return;
    // A port may commit before throwing: missing receipt never proves zero effects.
    if (!receipt.remove) throw new Error('Extension registration cleanup is unknown.');
    if (slots.get(id) !== occurrence) return;
    slots.delete(id);
    return Reflect.apply(receipt.remove, undefined, []);
  });
  track(cleanup);
  requireCurrent();
  slots.set(id, occurrence);
  entered = true;
  receipt.remove = Reflect.apply(method, target, [slot, contribution]);
  return cleanup;
}
/** Every captured obligation is attempted even when an earlier one throws. */
export function disposeTogether(callbacks: Array<() => void>): void {
  let failed = false;
  let first: unknown;
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  if (failed) throw first;
}

/** Preserve the first cleanup result or failure without replaying its native obligation. */
export function retainCleanup(release: () => void): () => void {
  let attempted = false;
  let failed = false;
  let result: void;
  let cause: unknown;
  return () => {
    if (!attempted) {
      attempted = true;
      try {
        result = Reflect.apply(release, undefined, []);
      } catch (error) {
        failed = true;
        cause = error;
      }
    }
    if (failed) throw cause;
    return result;
  };
}

/** Register and retain the exact subscription before any post-entry owner observation. */
export function subscribeOwned(
  context: { owner: { requireCurrent: () => void; track: (cleanup: () => void) => () => void } },
  port: object,
  method: (...args: unknown[]) => () => void,
  args: unknown[]
): () => void {
  context.owner.requireCurrent();
  const release = Reflect.apply(method, port, args);
  const cleanup = retainCleanup(release);
  // A started registration may return after retirement; retain its exact obligation.
  context.owner.track(cleanup);
  context.owner.requireCurrent();
  return cleanup;
}

/** Observe a throwing lifetime guard without introducing another authority. */
export function isHostCurrent(requireCurrent: () => void): boolean {
  try {
    requireCurrent();
    return true;
  } catch {
    return false;
  }
}
