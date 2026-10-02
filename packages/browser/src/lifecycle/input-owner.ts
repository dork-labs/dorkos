import { createEngineInput, type EngineTabInput } from '../input/engine-input.js';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserBinding } from '../contracts.js';
import type { BrowserRecord, TabRecord } from './records.js';
import type { PageInputCustody } from '../input/page-transport.js';
import { BrowserLifecycleError } from './errors.js';
import { sameBinding } from '../input/binding.js';

/** A preregistered construction slot remains owned even when a factory throws or returns late. */
export interface InputOwnerSlot {
  readonly tab: TabRecord;
  readonly constructed: Promise<void>;
  constructing: boolean;
  ready: boolean;
  uncertain: boolean;
  handle?: EngineTabInput;
  closePromise?: Promise<PageInputCustody>;
  closePending: boolean;
  resetPromise?: ReturnType<EngineTabInput['reset']>;
  readiness?: Promise<void>;
}

/** Enter an exact child's existing close once; its installed promise/end is never replaced. */
export function closeInput(record: BrowserRecord, slot: InputOwnerSlot): void {
  slot.ready = false;
  if (!slot.handle || slot.closePromise || slot.closePending) return;
  slot.closePending = true;
  try {
    const close = slot.handle.close;
    const operation = Reflect.apply(close, slot.handle, [
      record.lifetime.inputEnd,
    ]) as Promise<PageInputCustody>;
    slot.closePromise = operation;
    void Promise.resolve(operation).then(
      () => {
        slot.closePending = false;
      },
      () => {
        slot.closePending = false;
        slot.uncertain = true;
      }
    );
  } catch {
    slot.closePending = false;
    slot.uncertain = true;
  }
}

/** Canonical Map identity is required, including while the exact initial record is opening. */
export function currentTab(record: BrowserRecord, tab: TabRecord): boolean {
  return (
    !record.lifetime.gate.stopped &&
    !tab.stopped &&
    (record.status === 'opening' || record.status === 'running') &&
    record.tabs.get(tab.binding.tabId) === tab
  );
}

/** Compose only after the parent's initial navigation, with custody installed before Page getters. */
export function composeInput(
  config: EngineConfiguration,
  record: BrowserRecord,
  tab: TabRecord
): InputOwnerSlot {
  const prior = record.lifetime.inputs.get(tab);
  if (prior) return prior;
  if (!currentTab(record, tab)) throw new BrowserLifecycleError('BROWSER_STOPPED');
  let constructed!: () => void;
  const construction = new Promise<void>((done) => {
    constructed = done;
  });
  const slot: InputOwnerSlot = {
    tab,
    constructed: construction,
    constructing: true,
    ready: false,
    uncertain: false,
    closePending: false,
  };
  record.lifetime.inputs.set(tab, slot);
  try {
    slot.handle = createEngineInput({
      tab,
      stopGate: record.lifetime.gate,
      policy: config.policy,
      readTab: () => (currentTab(record, tab) ? record.tabs.get(tab.binding.tabId)! : null),
    });
    slot.constructing = false;
    if (!currentTab(record, tab)) closeInput(record, slot);
    const ready = slot.handle.ready;
    slot.readiness = Promise.resolve(ready)
      .then(() => {
        if (!currentTab(record, tab) || slot.closePromise || slot.closePending)
          throw new BrowserLifecycleError('BROWSER_STOPPED');
        slot.ready = true;
      })
      .catch((error: unknown) => {
        slot.uncertain = true;
        record.lifetime.gate.stop();
        record.lifetime.retire?.();
        throw error;
      });
    void slot.readiness.catch(() => {});
  } catch (error) {
    slot.constructing = false;
    slot.uncertain = true;
    record.lifetime.gate.stop();
    record.lifetime.retire?.();
    throw error;
  } finally {
    constructed();
  }
  return slot;
}

/** Input closure and browser disappearance are distinct evidence and must both be settled. */
export function inputsSettled(record: BrowserRecord): boolean {
  for (const slot of record.lifetime.inputs.values()) {
    if (
      slot.constructing ||
      slot.uncertain ||
      slot.closePending ||
      !slot.handle ||
      !slot.closePromise
    )
      return false;
    try {
      const c = slot.handle.custody();
      if (c.acquisitionPending || c.nativePending || c.detachPending || !c.detached || c.uncertain)
        return false;
    } catch {
      slot.uncertain = true;
      return false;
    }
  }
  return true;
}

/** Public parent actions require the ready, exact current record, not a historical captured Page. */
export function readyInput(record: BrowserRecord, binding: BrowserBinding): InputOwnerSlot {
  const tab = record.tabs.get(binding.tabId);
  if (
    !tab ||
    record.status !== 'running' ||
    !currentTab(record, tab) ||
    !sameBinding(tab.binding, binding)
  )
    throw new BrowserLifecycleError('STALE_BINDING');
  const slot = record.lifetime.inputs.get(tab);
  if (!slot?.ready || !slot.handle || slot.constructing || slot.uncertain)
    throw new BrowserLifecycleError('BROWSER_STOPPED');
  return slot;
}
