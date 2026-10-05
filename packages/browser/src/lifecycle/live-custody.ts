import type { BrowserRecord } from './records.js';
import { ordinaryRecord } from './ownership.js';

/** Observe only the captured engine originals; no caller DTO can supply custody. */
export function currentAuthorityCustody(record: BrowserRecord, current: () => boolean): boolean {
  const lifetime = record.lifetime;
  const ordinary = lifetime.ordinary;
  const local = () =>
    current() &&
    record.lifetime === lifetime &&
    ordinaryRecord(record) &&
    record.status === 'running' &&
    !lifetime.gate.stopped &&
    !lifetime.uncertain &&
    !lifetime.closeFailed &&
    !lifetime.releasePending &&
    !record.setupCleanupUncertain &&
    !record.closePromise &&
    !!record.context &&
    !!record.proxy &&
    !!record.directory &&
    !!record.dataRoot &&
    record.launchEntered &&
    record.rootAttributed &&
    !!record.root &&
    lifetime.contextCloses.size === 0 &&
    lifetime.proxyCloses.size === 0 &&
    ordinary.retirement.firstCause === null &&
    !ordinary.retirement.coverageUnavailable;
  if (!local() || record.tabs.size === 0 || lifetime.inputs.size !== record.tabs.size) return false;
  const journal = record.journal,
    supervisor = record.supervisor;
  const owners = [...record.tabs.values()].map((tab) => ({ tab, slot: lifetime.inputs.get(tab) }));
  const exact = () =>
    local() &&
    record.journal === journal &&
    record.supervisor === supervisor &&
    record.tabs.size === owners.length &&
    lifetime.inputs.size === owners.length &&
    owners.every(
      ({ tab, slot }) =>
        !!slot && record.tabs.get(tab.binding.tabId) === tab && lifetime.inputs.get(tab) === slot
    );
  try {
    if (record.networkPeer && record.networkCustody?.() !== true) return false;
    if (journal) {
      const custody = journal.custody();
      // An active original observer is expected to remain owned, not returned.
      if (!custody.pending || custody.uncertain || journal.historyGapped()) return false;
    }
    if (supervisor) {
      const custody = supervisor.custody();
      if (!custody.pending || custody.uncertain) return false;
    }
    if (!exact()) return false;
    for (const { tab, slot } of owners) {
      if (
        !slot ||
        tab.stopped ||
        slot.tab !== tab ||
        slot.page !== tab.page ||
        slot.constructing ||
        !slot.ready ||
        slot.uncertain ||
        slot.closePending ||
        slot.closePromise ||
        slot.retirement ||
        !slot.handle ||
        !slot.registeredTarget ||
        slot.registeredTarget.page !== tab.page
      )
        return false;
      const handle = slot.handle;
      const target = slot.registeredTarget;
      // Reset fences new input, but retains the original browser/network authority.
      // This genuine input-owner predicate deliberately distinguishes held ordinary
      // work from sticky unknown custody. Older producers cannot assert a positive.
      const known = handle.isCustodyKnown;
      if (typeof known !== 'function' || Reflect.apply(known, handle, []) !== true) return false;
      if (
        !exact() ||
        slot.handle !== handle ||
        slot.registeredTarget !== target ||
        slot.uncertain ||
        !slot.ready ||
        slot.constructing ||
        slot.closePending ||
        slot.closePromise ||
        slot.retirement ||
        tab.stopped ||
        slot.page !== tab.page ||
        target.page !== tab.page
      )
        return false;
    }
    return exact();
  } catch {
    return false;
  }
}
