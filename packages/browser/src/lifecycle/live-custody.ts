import type { BrowserRecord, TabRecord } from './records.js';
import { ordinaryRecord } from './ownership.js';
import { popupOwnsHandle, popupCohortKnown } from '../tabs/popup-navigation.js';

/** Fixed private cause vocabulary; never contains participant data or an error message. */
export type AuthorityCustodyRefusalStage =
  | 'local'
  | 'membership'
  | 'network'
  | 'journal'
  | 'supervisor'
  | 'slot'
  | 'transport'
  | 'reentrant'
  | 'popup'
  | 'exception';
const refusals = new WeakMap<BrowserRecord, AuthorityCustodyRefusalStage>();
/** Data-only observation of the most recent actual custody decision. */
export function readAuthorityCustodyRefusal(
  record: BrowserRecord
): AuthorityCustodyRefusalStage | undefined {
  return refusals.get(record);
}

/** Observe only the captured engine originals; no caller DTO can supply custody. */
export function currentAuthorityCustody(record: BrowserRecord, current: () => boolean): boolean {
  const refuse = (stage: AuthorityCustodyRefusalStage): false => {
    refusals.set(record, stage);
    return false;
  };
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
  if (!local()) return refuse('local');
  if (record.tabs.size === 0 || lifetime.inputs.size !== record.tabs.size)
    return refuse('membership');
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
    if (record.networkPeer && record.networkCustody?.() !== true) return refuse('network');
    if (record.controllerWire && !record.controllerWire.isKnown()) return refuse('transport');
    if (record.controllerAuthentication && !record.controllerAuthentication.isKnown())
      return refuse('transport');
    if (journal) {
      const custody = journal.custody();
      // An active original observer is expected to remain owned, not returned.
      if (!custody.pending || custody.uncertain || journal.historyGapped())
        return refuse('journal');
    }
    if (supervisor) {
      const custody = supervisor.custody();
      if (!custody.pending || custody.uncertain) return refuse('supervisor');
    }
    if (!exact()) return refuse('reentrant');
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
        return refuse('slot');
      const handle = slot.handle;
      const target = slot.registeredTarget;
      const pendingPopup = !slot.ready && popupOwnsHandle(tab, handle);
      if (pendingPopup) pendingOriginals.push({ tab, handle });
      if ((!slot.ready || !target) && !pendingPopup) return refuse('slot');
      // Reset fences new input, but retains the original browser/network authority.
      // This genuine input-owner predicate deliberately distinguishes held ordinary
      // work from sticky unknown custody. Older producers cannot assert a positive.
      const known = pendingPopup ? handle.isPopupCustodyKnown : handle.isCustodyKnown;
      if (typeof known !== 'function' || Reflect.apply(known, handle, []) !== true)
        return refuse('transport');
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
        return refuse('reentrant');
    }
    if (!exact()) return refuse('reentrant');
    if (!popupCohortKnown(pendingOriginals)) return refuse('popup');
    refusals.delete(record);
    return true;
  } catch {
    return refuse('exception');
  }
}
