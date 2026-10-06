import { types as nodeTypes } from 'node:util';
import { createEngineInput, type EngineTabInput } from '../input/engine-input.js';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserBinding } from '../contracts.js';
import type { BrowserRecord, TabRecord } from './records.js';
import type { PageInputCustody } from '../input/page-transport.js';
import { BrowserLifecycleError } from './errors.js';
import { sameBinding } from '../input/binding.js';
import { ordinaryRecord, issueCleanupPermit, enterCleanupAttempt } from './ownership.js';
import type { CleanupTarget, CleanupObservation } from './ownership.js';
import type { InputCleanupRoute } from '../input/types.js';
import type { ReleaseLedger } from '../input/held.js';

/** A preregistered construction slot remains owned even when a factory throws or returns late. */
export interface InputOwnerSlot {
  readonly tab: TabRecord;
  readonly page: TabRecord['page'];
  readonly constructed: Promise<void>;
  constructing: boolean;
  ready: boolean;
  uncertain: boolean;
  handle?: EngineTabInput;
  closePromise?: Promise<PageInputCustody>;
  closePending: boolean;
  resetPromise?: ReturnType<EngineTabInput['reset']>;
  readiness?: Promise<void>;
  registeredTarget?: Readonly<{ page: TabRecord['page']; transport: object; session: object }>;
  releaseLedger?: ReleaseLedger;
  retirement?: Promise<CleanupObservation>;
  retireOwner?: (end: number) => Promise<CleanupObservation>;
}

/** Enter an exact child's existing close once; its installed promise/end is never replaced. */
export function closeInput(record: BrowserRecord, slot: InputOwnerSlot): void {
  slot.ready = false;
  if (!record.lifetime.ordinary.retirement.terminalEntered) {
    record.lifetime.requestRetirement('explicitStop');
    return;
  }
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
    ordinaryRecord(record) &&
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
  if (!currentTab(record, tab)) throw new BrowserLifecycleError('BROWSER_STOPPED');
  const prior = record.lifetime.inputs.get(tab);
  if (prior) return prior;
  let constructed!: () => void;
  const construction = new Promise<void>((done) => {
    constructed = done;
  });
  const slot: InputOwnerSlot = {
    tab,
    page: tab.page,
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
      preserveFocus: record.supervisor !== undefined,
      cleanup: cleanupRoute(record, slot),
      stopGate: record.lifetime.gate,
      policy: config.policy,
      // Canonical membership also remains observable during cleanup; ordinary admission is separate.
      readTab: () => (record.tabs.get(tab.binding.tabId) === tab ? tab : null),
    });
    const handle = slot.handle;
    const retire = handle.retire;
    slot.retireOwner = (end) => Reflect.apply(retire, handle, [end]);
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
        record.lifetime.requestRetirement('engineFault');
        throw error;
      });
    void slot.readiness.catch(() => {});
  } catch (error) {
    slot.constructing = false;
    slot.uncertain = true;
    record.lifetime.requestRetirement('engineFault');
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

/** One genuine engine-owned producer route per exact preregistered input slot. */
export function cleanupRoute(record: BrowserRecord, owner: InputOwnerSlot): InputCleanupRoute {
  const exact = (
    binding: import('../contracts.js').BrowserBinding,
    transport: object,
    session: object,
    page: TabRecord['page']
  ): boolean => {
    const cell = record.lifetime.ordinary;
    const target = owner.registeredTarget;
    return (
      cell.record === record &&
      cell.records !== null &&
      Map.prototype.get.call(cell.records, record.browserId) === record &&
      record.lifetime.inputs.get(owner.tab) === owner &&
      record.tabs.get(binding.tabId) === owner.tab &&
      target?.page === page &&
      owner.page === page &&
      owner.tab.page === page &&
      target.transport === transport &&
      target.session === session &&
      !owner.tab.stopped &&
      !record.lifetime.gate.stopped &&
      sameBinding(owner.tab.binding, binding)
    );
  };
  let lastNow: number | undefined;
  let clockUnavailable = false;
  const route: InputCleanupRoute = {
    requestRetirement: (cause) => {
      if (cause === 'engineFault' || cause === 'cleanupFailure') owner.uncertain = true;
      record.lifetime.requestRetirement(cause);
    },
    terminal: () => record.lifetime.ordinary.retirement.terminalEntered,
    ordinary: () => currentTab(record, owner.tab) && owner.tab.page === owner.page,
    retiring: () => record.lifetime.ordinary.phase === 'retiring',
    binding: () => {
      const target = owner.registeredTarget;
      if (!target || !exact(owner.tab.binding, target.transport, target.session, target.page))
        return null;
      return Object.freeze({ ...owner.tab.binding });
    },
    registerTarget: (page, transport, session) => {
      if (
        !currentTab(record, owner.tab) ||
        owner.registeredTarget ||
        page !== owner.page ||
        owner.tab.page !== owner.page
      ) {
        owner.uncertain = true;
        throw new BrowserLifecycleError('BROWSER_STOPPED');
      }
      owner.registeredTarget = Object.freeze({ page: owner.page, transport, session });
    },
    registerLedger: (ledger) => {
      if (owner.releaseLedger && owner.releaseLedger !== ledger) return false;
      if (record.lifetime.inputs.get(owner.tab) !== owner) return false;
      owner.releaseLedger = ledger;
      const slot = record.lifetime.ordinary.retirement;
      const cohort = slot.cohorts.get(owner);
      if (record.lifetime.ordinary.phase === 'retiring') {
        if (!cohort || !slot.snapshotTaken) return false;
        for (const attempt of ledger.attempts) {
          const prior = cohort.attempts.get(attempt.identity);
          if (prior && prior !== attempt) return false;
          cohort.attempts.set(attempt.identity, attempt);
        }
      }
      return true;
    },
    releaseLedger: (ledger) => {
      if (currentTab(record, owner.tab) && owner.releaseLedger === ledger && ledger.finished)
        owner.releaseLedger = undefined;
    },
    permit: (binding, end) => {
      const slot = record.lifetime.ordinary.retirement;
      const cohort = slot.cohorts.get(owner);
      const registered = owner.registeredTarget;
      if (
        !cohort ||
        !registered ||
        !route.retiring() ||
        !exact(binding, registered.transport, registered.session, registered.page) ||
        !Number.isFinite(end) ||
        end < 0 ||
        slot.inputEnd === undefined ||
        slot.end === undefined ||
        end > slot.inputEnd ||
        end > slot.end
      )
        return null;
      if (!cohort.target) {
        const target: CleanupTarget = Object.freeze({
          record,
          owner,
          tab: owner.tab,
          page: registered.page,
          transport: registered.transport,
          session: registered.session,
          binding: Object.freeze({ ...binding }),
          end,
        });
        cohort.target = target;
      } else if (!sameBinding(cohort.target.binding, binding) || cohort.target.end !== end)
        return null;
      return issueCleanupPermit(record, owner);
    },
    enter: (permit, attempt) => enterCleanupAttempt(record, permit, attempt) !== null,
    allows: (permit, binding, transport, session, page) => {
      const slot = record.lifetime.ordinary.retirement;
      const cohort = slot.cohorts.get(owner);
      const target = cohort?.permits.get(permit);
      if (clockUnavailable || !target || !cohort) return false;
      // All fallible binding observation precedes the final clock. Accessors are not final facts.
      const descriptor = Object.getOwnPropertyDescriptor(owner.tab, 'binding');
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
      const dataBinding: unknown = descriptor.value;
      if (
        !dataBinding ||
        typeof dataBinding !== 'object' ||
        Array.isArray(dataBinding) ||
        nodeTypes.isProxy(dataBinding)
      )
        return false;
      const prototype = Object.getPrototypeOf(dataBinding);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const fields = [
        'browserId',
        'browserGeneration',
        'tabId',
        'navigationGeneration',
        'viewportVersion',
        'epoch',
        'inputGeneration',
      ] as const;
      const descriptors = Object.getOwnPropertyDescriptors(dataBinding);
      if (Reflect.ownKeys(descriptors).length !== fields.length) return false;
      const facts = new Map<string, unknown>();
      for (const field of fields) {
        const value = descriptors[field];
        if (
          !value ||
          !value.enumerable ||
          !Object.hasOwn(value, 'value') ||
          value.value !== binding[field]
        )
          return false;
        facts.set(field, value.value);
      }
      if (
        !exact(binding, transport, session, page) ||
        !sameBinding(target.binding, binding) ||
        target.page !== page ||
        target.transport !== transport ||
        target.session !== session
      )
        return false;
      const lifetime = record.lifetime,
        cell = lifetime.ordinary;
      const registered = owner.registeredTarget;
      let now: number;
      try {
        now = performance.now();
      } catch {
        clockUnavailable = true;
        owner.uncertain = true;
        return false;
      }
      if (
        !Number.isFinite(now) ||
        now < 0 ||
        now > Number.MAX_SAFE_INTEGER ||
        (lastNow !== undefined && now < lastNow)
      ) {
        clockUnavailable = true;
        owner.uncertain = true;
        return false;
      }
      lastNow = now;
      // Only private own-data identities/descriptors follow the clock: no Page/route/caller callbacks.
      const finalDescriptor = Object.getOwnPropertyDescriptor(owner.tab, 'binding');
      if (
        record.lifetime !== lifetime ||
        lifetime.ordinary !== cell ||
        cell.phase !== 'retiring' ||
        cell.retirement !== slot ||
        cell.record !== record ||
        !cell.records ||
        record.browserId !== facts.get('browserId') ||
        record.browserGeneration !== facts.get('browserGeneration') ||
        Map.prototype.get.call(cell.records, record.browserId) !== record ||
        Map.prototype.get.call(lifetime.inputs, owner.tab) !== owner ||
        Map.prototype.get.call(record.tabs, facts.get('tabId')) !== owner.tab ||
        Map.prototype.get.call(slot.cohorts, owner) !== cohort ||
        Map.prototype.get.call(cohort.permits, permit) !== target ||
        owner.registeredTarget !== registered ||
        registered?.page !== page ||
        registered.transport !== transport ||
        registered.session !== session ||
        owner.page !== page ||
        owner.tab.page !== page ||
        owner.tab.stopped ||
        lifetime.gate.stopped ||
        !finalDescriptor ||
        !Object.hasOwn(finalDescriptor, 'value') ||
        finalDescriptor.value !== dataBinding ||
        now >= target.end ||
        Reflect.ownKeys(dataBinding).length !== fields.length
      )
        return false;
      for (const field of fields) {
        const value = Object.getOwnPropertyDescriptor(dataBinding, field);
        if (
          !value ||
          !value.enumerable ||
          !Object.hasOwn(value, 'value') ||
          value.value !== facts.get(field)
        )
          return false;
      }
      return cell.phase === 'retiring';
    },
    settlement: (binding, transport, session, page) => exact(binding, transport, session, page),
  };
  return Object.freeze(route);
}
