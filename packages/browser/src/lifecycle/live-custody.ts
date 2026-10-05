import type { BrowserRecord, TabRecord } from './records.js';
import { ordinaryRecord } from './ownership.js';
import { popupOwnsHandle, popupCohortKnown } from '../tabs/popup-navigation.js';

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
    const pendingOriginals: { tab: TabRecord; handle: object }[] = [];
    for (const { tab, slot } of owners) {
      if (
        !slot ||
        tab.stopped ||
        slot.tab !== tab ||
        slot.page !== tab.page ||
        slot.constructing ||
        slot.uncertain ||
        slot.closePending ||
        slot.closePromise ||
        slot.retirement ||
        !slot.handle ||
        (slot.registeredTarget && slot.registeredTarget.page !== tab.page)
      )
        return false;
      const handle = slot.handle;
      const target = slot.registeredTarget;
      const pendingPopup = !slot.ready && popupOwnsHandle(tab, handle);
      if (pendingPopup) pendingOriginals.push({ tab, handle });
      if ((!slot.ready || !target) && !pendingPopup) return false;
      // Reset fences new input, but retains the original browser/network authority.
      // This genuine input-owner predicate deliberately distinguishes held ordinary
      // work from sticky unknown custody. Older producers cannot assert a positive.
      const known = pendingPopup ? handle.isPopupCustodyKnown : handle.isCustodyKnown;
      if (typeof known !== 'function' || Reflect.apply(known, handle, []) !== true) return false;
      if (
        !exact() ||
        slot.handle !== handle ||
        slot.registeredTarget !== target ||
        slot.uncertain ||
        (!slot.ready && !pendingPopup) ||
        (pendingPopup && !popupOwnsHandle(tab, handle)) ||
        slot.constructing ||
        slot.closePending ||
        slot.closePromise ||
        slot.retirement ||
        tab.stopped ||
        slot.page !== tab.page ||
        (target && target.page !== tab.page)
      )
        return false;
    }
    return exact() && popupCohortKnown(pendingOriginals);
  } catch {
    return false;
  }
}
