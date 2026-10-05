import type { BrowserBinding } from '../contracts.js';
import type { BrowserRecord, TabRecord } from './records.js';
import { ordinaryRecord } from './ownership.js';
import { sameBinding } from '../input/binding.js';
import { advanceCounter } from '../counters.js';

/** One original first-document operation; no body or boolean supplies this capability. */
export interface InitialNavigationOwner {
  readonly record: BrowserRecord;
  readonly tab: TabRecord;
  readonly page: TabRecord['page'];
  readonly binding: Readonly<BrowserBinding>;
  readonly current: () => boolean;
  phase: 'preparing' | 'entered' | 'committed' | 'completed' | 'failed';
  target: string | null;
  inputOwner: object | null;
  cleanupUncertain: boolean;
}
const records = new WeakMap<BrowserRecord, InitialNavigationOwner>();
const tabs = new WeakMap<TabRecord, InitialNavigationOwner>();
const retained = new Set<InitialNavigationOwner>();

/** Synchronous one-shot admission fence precedes every URL, policy or Page callback. */
export function claimInitialNavigation(
  record: BrowserRecord,
  current: () => boolean
): InitialNavigationOwner | null {
  if (
    records.has(record) ||
    !current() ||
    !ordinaryRecord(record) ||
    record.status !== 'running' ||
    record.lifetime.gate.stopped ||
    !record.networkPeer ||
    record.tabs.size !== 1
  )
    return null;
  const tab = Map.prototype.values.call(record.tabs).next().value as TabRecord | undefined;
  if (
    !tab ||
    tab.stopped ||
    tab.pending !== 0 ||
    tab.binding.navigationGeneration !== 0 ||
    tab.binding.epoch !== 0 ||
    tab.binding.inputGeneration !== 0
  )
    return null;
  const owner: InitialNavigationOwner = {
    record,
    tab,
    page: tab.page,
    binding: Object.freeze({ ...tab.binding }),
    current,
    phase: 'preparing',
    target: null,
    inputOwner: null,
    cleanupUncertain: false,
  };
  records.set(record, owner);
  tabs.set(tab, owner);
  retained.add(owner);
  return owner;
}
/** Known retained navigation owns admission without changing resource custody. */
export function initialNavigationPending(record: BrowserRecord): boolean {
  const owner = records.get(record);
  return !!owner && ['preparing', 'entered', 'committed'].includes(owner.phase);
}
/** Native admission fence on the original tab, including before policy callbacks. */
export function initialNavigationInputFenced(tab: TabRecord): boolean {
  const owner = tabs.get(tab);
  return !!owner && ['preparing', 'entered', 'committed'].includes(owner.phase);
}
/** Recheck the captured canonical cohort after any fallible callback. */
export function currentInitialNavigation(owner: InitialNavigationOwner): boolean {
  return (
    records.get(owner.record) === owner &&
    tabs.get(owner.tab) === owner &&
    owner.current() &&
    ordinaryRecord(owner.record) &&
    owner.record.status === 'running' &&
    !owner.record.lifetime.gate.stopped &&
    !owner.tab.stopped &&
    owner.tab.page === owner.page &&
    owner.record.tabs.get(owner.binding.tabId) === owner.tab
  );
}
/** Commit only the requested first URL once; redirects and competing commits retire normally. */
export function commitInitialNavigation(tab: TabRecord, url: string): boolean | null {
  const owner = tabs.get(tab);
  if (!owner || owner.phase === 'completed' || owner.phase === 'failed') return null;
  if (
    owner.phase !== 'entered' ||
    !currentInitialNavigation(owner) ||
    owner.target !== url ||
    !sameBinding(tab.binding, owner.binding)
  )
    return false;
  tab.binding = Object.freeze({
    ...owner.binding,
    navigationGeneration: advanceCounter(owner.binding.navigationGeneration),
  });
  owner.phase = 'committed';
  return true;
}
/** Only the original unentered input owner can adopt this exact requested commit. */
export function adoptInitialNavigation(
  tab: TabRecord,
  initial: BrowserBinding,
  inputOwner: object
): Readonly<BrowserBinding> | null {
  const owner = tabs.get(tab);
  if (
    !owner ||
    owner.phase !== 'committed' ||
    owner.inputOwner !== null ||
    !currentInitialNavigation(owner) ||
    !sameBinding(initial, owner.binding) ||
    !sameBinding(tab.binding, {
      ...owner.binding,
      navigationGeneration: advanceCounter(owner.binding.navigationGeneration),
    })
  )
    return null;
  owner.inputOwner = inputOwner;
  return Object.freeze({ ...tab.binding });
}
/** Release only returned observation custody; cleanup faults remain strongly retained. */
export function finishInitialNavigation(owner: InitialNavigationOwner, completed: boolean): void {
  owner.phase = completed ? 'completed' : 'failed';
  if (!owner.cleanupUncertain) retained.delete(owner);
}

/** Observed first commit and its original input-owner adoption remain current. */
export function initialNavigationCommitted(owner: InitialNavigationOwner): boolean {
  return (
    owner.phase === 'committed' && owner.inputOwner !== null && currentInitialNavigation(owner)
  );
}
