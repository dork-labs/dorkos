import type { BrowserBinding } from '../contracts.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { ordinaryRecord } from '../lifecycle/ownership.js';
import { sameBinding } from '../input/binding.js';
import { advanceCounter } from '../counters.js';

/** One retained original Page transition, with cleanup reset preceding native navigation. */
export interface NavigationCohort {
  readonly record: BrowserRecord;
  readonly lifetime: BrowserRecord['lifetime'];
  readonly tab: TabRecord;
  readonly page: TabRecord['page'];
  readonly before: Readonly<BrowserBinding>;
  readonly current: () => boolean;
  readonly inputOwner: object;
  binding: Readonly<BrowserBinding>;
  phase: 'preparing' | 'entered' | 'committed' | 'completed' | 'failed';
  target: string | null;
  adopted: boolean;
  cleanupUncertain: boolean;
}
const active = new WeakMap<TabRecord, NavigationCohort>();
const nativePreparing = new WeakMap<TabRecord, object>();
const inputOwners = new WeakMap<TabRecord, object>();
const inputAdopters = new WeakMap<TabRecord, () => boolean>();
const retained = new Set<NavigationCohort>();

/** Register only the constructor's original input owner, never a request-provided identity. */
export function registerNavigationInput(
  tab: TabRecord,
  owner: object,
  adopt?: () => boolean
): void {
  if (inputOwners.has(tab)) throw new Error('NAVIGATION_INPUT_ALREADY_REGISTERED');
  inputOwners.set(tab, owner);
  if (adopt) inputAdopters.set(tab, adopt);
}

/** Reject concurrent work rather than queue stale URLs against a successor document. */
export function claimNavigation(
  record: BrowserRecord,
  binding: BrowserBinding,
  current: () => boolean,
  preparation?: object
): NavigationCohort | null {
  const tab = record.tabs.get(binding.tabId);
  if (
    !tab ||
    (nativePreparing.has(tab) && nativePreparing.get(tab) !== preparation) ||
    active.has(tab) ||
    tab.pending !== 0 ||
    tab.stopped ||
    !sameBinding(tab.binding, binding)
  )
    return null;
  const inputOwner = inputOwners.get(tab);
  if (
    !inputOwner ||
    !current() ||
    !ordinaryRecord(record) ||
    record.status !== 'running' ||
    record.lifetime.gate.stopped ||
    !record.networkPeer
  )
    return null;
  // Reentrant authority reads above may have changed the actual tab or admitted competing work.
  if (
    (nativePreparing.has(tab) && nativePreparing.get(tab) !== preparation) ||
    active.has(tab) ||
    record.tabs.get(binding.tabId) !== tab ||
    tab.stopped ||
    tab.pending !== 0 ||
    !sameBinding(tab.binding, binding) ||
    inputOwners.get(tab) !== inputOwner
  )
    return null;
  const original = Object.freeze({ ...binding });
  const cohort: NavigationCohort = {
    record,
    lifetime: record.lifetime,
    tab,
    page: tab.page,
    before: original,
    binding: original,
    current,
    inputOwner,
    phase: 'preparing',
    target: null,
    adopted: false,
    cleanupUncertain: false,
  };
  active.set(tab, cohort);
  retained.add(cohort);
  return cohort;
}

/** Fence new input/capture immediately; original cleanup reset may still drain the old document. */
export function navigationPending(tab: TabRecord): boolean {
  return active.has(tab) || nativePreparing.has(tab);
}

/** Only the exact retained cohort can enter the original preparation reset. */
export function navigationOwnsReset(tab: TabRecord, cohort: NavigationCohort | undefined): boolean {
  return (
    !!cohort && active.get(tab) === cohort && cohort.tab === tab && cohort.phase === 'preparing'
  );
}

/** Exact callback-free final state fence; actor callbacks cannot revive admission. */
export function navigationStateCurrent(cohort: NavigationCohort): boolean {
  const lifetime = cohort.lifetime;
  return (
    active.get(cohort.tab) === cohort &&
    inputOwners.get(cohort.tab) === cohort.inputOwner &&
    cohort.record.lifetime === lifetime &&
    ordinaryRecord(cohort.record) &&
    cohort.record.browserId === cohort.before.browserId &&
    cohort.record.browserGeneration === cohort.before.browserGeneration &&
    cohort.record.status === 'running' &&
    !lifetime.gate.stopped &&
    !lifetime.uncertain &&
    !lifetime.closeFailed &&
    !lifetime.releasePending &&
    !cohort.record.setupCleanupUncertain &&
    !cohort.record.closePromise &&
    lifetime.ordinary.retirement.firstCause === null &&
    !lifetime.ordinary.retirement.coverageUnavailable &&
    cohort.record.tabs.get(cohort.before.tabId) === cohort.tab &&
    cohort.tab.page === cohort.page &&
    !cohort.tab.stopped
  );
}
/** Original map/current producer is followed by callback-free canonical state checks. */
export function currentNavigation(cohort: NavigationCohort): boolean {
  const current = cohort.current();
  return current && navigationStateCurrent(cohort);
}

/** Accept only the exact observed reset of this original document, never a rebound tab or mixed advance. */
export function navigationResetObserved(
  cohort: NavigationCohort,
  binding: BrowserBinding
): boolean {
  const expected = {
    ...cohort.before,
    epoch: advanceCounter(cohort.before.epoch),
    inputGeneration: advanceCounter(cohort.before.inputGeneration),
  };
  if (
    cohort.phase !== 'preparing' ||
    !sameBinding(binding, expected) ||
    !sameBinding(cohort.tab.binding, expected) ||
    !currentNavigation(cohort)
  )
    return false;
  if (cohort.phase !== 'preparing' || !sameBinding(cohort.tab.binding, expected)) return false;
  cohort.binding = Object.freeze({ ...binding });
  return true;
}

/** Main-frame registry adopts one exact target from this entered original cohort. */
export function commitNavigation(tab: TabRecord, url: string): boolean | null {
  const cohort = active.get(tab);
  if (!cohort) return null;
  if (
    cohort.phase !== 'entered' ||
    cohort.target !== url ||
    !sameBinding(tab.binding, cohort.binding) ||
    !currentNavigation(cohort)
  )
    return false;
  if (
    cohort.phase !== 'entered' ||
    cohort.target !== url ||
    !sameBinding(tab.binding, cohort.binding)
  )
    return false;
  tab.binding = Object.freeze({
    ...cohort.binding,
    navigationGeneration: advanceCounter(cohort.binding.navigationGeneration),
  });
  cohort.phase = 'committed';
  return true;
}

/** Only the previously captured input owner can resume on the genuine observed successor. */
export function adoptNavigation(
  tab: TabRecord,
  initial: BrowserBinding,
  owner: object
): Readonly<BrowserBinding> | null {
  const cohort = active.get(tab);
  if (!cohort || cohort.inputOwner !== owner || cohort.adopted || cohort.phase !== 'committed')
    return null;
  if (
    initial.browserId !== cohort.before.browserId ||
    initial.browserGeneration !== cohort.before.browserGeneration ||
    initial.tabId !== cohort.before.tabId ||
    initial.navigationGeneration !== cohort.before.navigationGeneration ||
    initial.viewportVersion !== cohort.before.viewportVersion
  )
    return null;
  const expected = {
    ...cohort.binding,
    navigationGeneration: advanceCounter(cohort.binding.navigationGeneration),
  };
  if (!sameBinding(tab.binding, expected) || !currentNavigation(cohort)) return null;
  if (cohort.adopted || cohort.phase !== 'committed' || !sameBinding(tab.binding, expected))
    return null;
  cohort.adopted = true;
  return Object.freeze({ ...expected });
}

/** Release admission only after original native/listener custody returned; unknown cleanup remains retained. */
export function finishNavigation(cohort: NavigationCohort, succeeded: boolean): void {
  cohort.phase = succeeded ? 'completed' : 'failed';
  if (!cohort.cleanupUncertain) {
    if (active.get(cohort.tab) === cohort) active.delete(cohort.tab);
    retained.delete(cohort);
  }
}

/** Original Page Route owner fences new producers while old originals naturally drain. */
export function prepareOwnerNavigation(tab: TabRecord): object | null {
  if (active.has(tab) || nativePreparing.has(tab) || tab.stopped) return null;
  const original = Object.freeze({});
  nativePreparing.set(tab, original);
  return original;
}
/** This clears only the pre-cohort fence; the actual cohort retains its own custody. */
export function finishOwnerPreparation(tab: TabRecord, preparation: object): void {
  if (nativePreparing.get(tab) === preparation) nativePreparing.delete(tab);
}

/** Existing explicit address cohorts retain their original authority and route chain. */
export function navigationHasCohort(tab: TabRecord): boolean {
  return active.has(tab);
}

/** Same-document commit already emitted its original native event before asynchronous reset.
 * Invoke the captured original input owner, never a fabricated Page event or receiver.
 */
export function adoptObservedOwnerNavigation(cohort: NavigationCohort): boolean {
  const adopt = inputAdopters.get(cohort.tab);
  if (!adopt || cohort.phase !== 'committed' || !currentNavigation(cohort)) return false;
  const returned = adopt();
  return returned && cohort.adopted && navigationStateCurrent(cohort);
}

/** Native hash-event preparation fences input before its retained reset/cohort is claimed. */
export function ownerPreparationPending(tab: TabRecord): boolean {
  return nativePreparing.has(tab) && !active.has(tab);
}
