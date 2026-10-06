import {
  navigationPending,
  navigationOwnsReset,
  type NavigationCohort,
} from '../navigation/cohort.js';
import type { OwnedInputWork } from '../input/owned-work.js';
import { initialNavigationPending } from './initial-navigation-state.js';
import type { BrowserBinding, BrowserCommand } from '../contracts.js';
import type { BrowserRecord } from './records.js';
import { sameBinding } from '../input/binding.js';
import type { InputResult, ResetResult } from '../input/types.js';
import { readyInput, currentTab } from './input-owner.js';
import { BrowserLifecycleError } from './errors.js';
import { ordinaryRecord } from './ownership.js';

/** Admission is rechecked after observing the child method; bodies never choose a Page. */
export function submitInput(
  record: BrowserRecord,
  command: Extract<BrowserCommand, { kind: 'input' }>,
  signal?: AbortSignal,
  ownedWork?: OwnedInputWork
): Promise<InputResult> {
  try {
    const navigationTab = record.tabs.get(command.binding.tabId);
    if (initialNavigationPending(record) || (navigationTab && navigationPending(navigationTab)))
      throw new BrowserLifecycleError('STALE_BINDING');
    const slot = readyInput(record, command.binding);
    if (slot.resetPromise) throw new BrowserLifecycleError('STALE_BINDING');
    const submit = slot.handle!.submit;
    if (slot.resetPromise || readyInput(record, command.binding) !== slot)
      throw new BrowserLifecycleError('STALE_BINDING');
    return Reflect.apply(submit, slot.handle!, [
      command,
      signal,
      ownedWork,
    ]) as Promise<InputResult>;
  } catch {
    return Promise.resolve(
      Object.freeze({
        kind: 'action',
        requestId: command.requestId,
        binding: command.binding,
        outcome: 'rejected',
        reason:
          record.lifetime.gate.stopped || !ordinaryRecord(record) ? 'stopped' : 'staleBinding',
      })
    );
  }
}

/** Coalesce reset with synchronous child publication before its first drain; failures retire admission. */
export function resetInput(
  record: BrowserRecord,
  binding: BrowserBinding,
  navigation?: NavigationCohort
): Promise<ResetResult> {
  const tab = record.tabs.get(binding.tabId);
  if (tab && navigationPending(tab) && !navigationOwnsReset(tab, navigation))
    return Promise.resolve(Object.freeze({ binding, status: 'stopped' }));
  if (initialNavigationPending(record))
    return Promise.resolve(Object.freeze({ binding, status: 'stopped' }));
  const slot = readyInput(record, binding);
  if (slot.resetPromise) return slot.resetPromise;
  let resolve!: (result: ResetResult) => void;
  const shared = new Promise<ResetResult>((done) => {
    resolve = done;
  });
  slot.resetPromise = shared;
  const fail = () => {
    slot.ready = false;
    // Retirement is a synchronous ordinary fence followed by cleanup-only drain, not early gate-stop.
    record.lifetime.requestRetirement('engineFault');
    resolve(Object.freeze({ binding: Object.freeze({ ...slot.tab.binding }), status: 'stopped' }));
  };
  try {
    const reset = slot.handle!.reset;
    if (readyInput(record, binding) !== slot) throw new BrowserLifecycleError('STALE_BINDING');
    const operation = Reflect.apply(reset, slot.handle!, []) as Promise<ResetResult>;
    void Promise.resolve(operation).then((result) => {
      if (
        result.status !== 'ready' ||
        !currentTab(record, slot.tab) ||
        !sameBinding(slot.tab.binding, result.binding)
      )
        fail();
      else resolve(result);
    }, fail);
  } catch {
    fail();
  }
  void shared.then(() => {
    if (slot.resetPromise === shared) slot.resetPromise = undefined;
  });
  return shared;
}
