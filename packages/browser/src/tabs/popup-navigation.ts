import type { BrowserContext, Page } from 'playwright-core';
import type { BrowserBinding } from '../contracts.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { ordinaryRecord, ownOperation } from '../lifecycle/ownership.js';
import { sameBinding } from '../input/binding.js';
import { advanceCounter } from '../counters.js';

interface Popup {
  record: BrowserRecord;
  tab: TabRecord;
  page: Page;
  context: BrowserContext;
  initial: Readonly<BrowserBinding>;
  end: number;
  phase: 'pending' | 'committing' | 'committed' | 'completed' | 'failed';
  openerPending: boolean;
  opener: Promise<TabRecord | null>;
  parent?: {
    tab: TabRecord;
    page: Page;
    frame: ReturnType<Page['mainFrame']>;
    url: string;
    origin: string;
    binding: Readonly<BrowserBinding>;
  };
  commit?: Promise<boolean>;
  commitPending: boolean;
  adopted: object | null;
  input: object | null;
  handle: object | null;
  originalReady?: Promise<void>;
  inputReady?: Promise<void>;
  inputPending: boolean;
  viewportPending: boolean;
  viewportOriginal?: Promise<void>;
  viewportReady?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}
const owners = new WeakMap<TabRecord, Popup>();
// Unsettled opener observations stay owned, including after timeout; no cancellation claim.
const retained = new Set<Popup>();
const current = (owner: Popup) =>
  ordinaryRecord(owner.record) &&
  owner.record.context === owner.context &&
  owner.record.tabs.get(owner.initial.tabId) === owner.tab &&
  owner.tab.page === owner.page &&
  !owner.tab.stopped &&
  !owner.record.lifetime.gate.stopped;
function refuse(owner: Popup): void {
  owner.phase = 'failed';
  clearTimeout(owner.timer);
  owner.record.lifetime.requestRetirement('engineFault');
  releaseObservation(owner);
}

function releaseObservation(owner: Popup): void {
  if (
    (owner.phase === 'failed' || owner.phase === 'completed') &&
    !owner.openerPending &&
    !owner.inputPending &&
    !owner.commitPending &&
    !owner.viewportPending
  )
    retained.delete(owner);
}

/** Only the original context Page-event caller supplies this observation, never enumeration. */
export function observePopup(record: BrowserRecord, tab: TabRecord, context: BrowserContext): void {
  if (owners.has(tab)) return;
  if (retained.size >= 16 || context !== record.context || !ordinaryRecord(record)) {
    record.lifetime.requestRetirement('engineFault');
    return;
  }
  const page = tab.page;
  // Already committed Pages need no exceptional commit allowance. A blank original is mandatory.
  try {
    if (page.context() !== context || page.url() !== 'about:blank') return;
    if (
      !ordinaryRecord(record) ||
      record.context !== context ||
      tab.page !== page ||
      record.tabs.get(tab.binding.tabId) !== tab ||
      tab.stopped
    ) {
      record.lifetime.requestRetirement('engineFault');
      return;
    }
  } catch {
    record.lifetime.requestRetirement('engineFault');
    return;
  }
  const initial = Object.freeze({ ...tab.binding });
  const owner: Popup = {
    record,
    tab,
    page,
    context,
    initial,
    end: performance.now() + 1500,
    phase: 'pending',
    openerPending: true,
    opener: Promise.resolve(null),
    adopted: null,
    input: null,
    handle: null,
    inputPending: false,
    commitPending: false,
    viewportPending: true,
  };
  owners.set(tab, owner);
  retained.add(owner); // Charge before any opener getter/callback or returned asynchronous duty.
  const expire = () => {
    if (owner.phase === 'completed' || owner.phase === 'failed') return;
    const remaining = owner.end - performance.now();
    if (remaining > 0) {
      owner.timer = setTimeout(expire, remaining);
      return;
    }
    refuse(owner);
    releaseObservation(owner);
  };
  owner.timer = setTimeout(expire, Math.max(0, owner.end - performance.now()));
  // Own the exact asynchronous setter before any SDK entry. Expiry never cancels or drops it.
  owner.viewportOriginal = Promise.resolve().then(() =>
    ownOperation(record, () => {
      if (!current(owner) || owner.phase === 'failed' || performance.now() >= owner.end)
        throw Error('POPUP_VIEWPORT_REFUSED');
      const setViewport = page.setViewportSize;
      if (!current(owner) || page.context() !== owner.context || !current(owner))
        throw Error('POPUP_VIEWPORT_REFUSED');
      return Reflect.apply(setViewport, page, [{ width: 1280, height: 720 }]) as Promise<void>;
    })
  );
  owner.viewportReady = owner.viewportOriginal
    .then(() => {
      if (!viewportKnown(owner)) throw Error('POPUP_VIEWPORT_REFUSED');
    })
    .catch((error: unknown) => {
      refuse(owner);
      throw error;
    })
    .finally(() => {
      owner.viewportPending = false;
      releaseObservation(owner);
    });
  void owner.viewportReady.catch(() => {});

  try {
    const opener = page.opener;
    if (!current(owner)) throw Error('POPUP_OBSERVATION_REFUSED');
    owner.opener = Promise.resolve(Reflect.apply(opener, page, []))
      .then(
        (original: Page | null) => {
          const candidates = [...record.tabs.values()].filter(
            (value) => value !== tab && value.page === original
          );
          const parent = candidates.length === 1 ? candidates[0]! : null;
          if (
            !parent ||
            parent.stopped ||
            !current(owner) ||
            performance.now() >= owner.end ||
            owner.phase === 'failed' ||
            original?.context() !== context ||
            (owner.phase === 'pending' && page.url() !== 'about:blank')
          ) {
            refuse(owner);
            return null;
          }
          const parentPage = parent.page,
            frame = parentPage.mainFrame();
          const binding = Object.freeze({ ...parent.binding });
          const url = parentPage.url(),
            frameURL = frame.url();
          const parsed = new URL(url);
          if (
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            url !== frameURL ||
            parentPage.context() !== context ||
            record.tabs.get(binding.tabId) !== parent ||
            parent.page !== parentPage ||
            !sameBinding(parent.binding, binding) ||
            parent.stopped ||
            !current(owner)
          ) {
            refuse(owner);
            return null;
          }
          owner.parent = {
            tab: parent,
            page: parentPage,
            frame,
            url,
            origin: parsed.origin,
            binding,
          };
          return parent;
        },
        () => {
          refuse(owner);
          return null;
        }
      )
      .catch(() => {
        refuse(owner);
        return null;
      })
      .finally(() => {
        owner.openerPending = false;
        releaseObservation(owner);
      });
  } catch {
    owner.openerPending = false;
    refuse(owner);
    clearTimeout(owner.timer);
    releaseObservation(owner);
  }
}

function viewportKnown(owner: Popup): boolean {
  const active = () => owner.phase !== 'failed';
  try {
    if (
      !current(owner) ||
      !active() ||
      performance.now() >= owner.end ||
      owner.page.context() !== owner.context ||
      !current(owner)
    )
      return false;
    const size = owner.page.viewportSize();
    return (
      !!size &&
      size.width === 1280 &&
      size.height === 720 &&
      current(owner) &&
      active() &&
      performance.now() < owner.end
    );
  } catch {
    return false;
  }
}

/** Reobserve only the captured canonical opener originals; no configuration-origin replacement. */
function parentKnown(owner: Popup, parent: TabRecord): boolean {
  const snapshot = owner.parent;
  if (!snapshot || snapshot.tab !== parent) return false;
  try {
    return (
      current(owner) &&
      !parent.stopped &&
      owner.record.tabs.get(snapshot.binding.tabId) === parent &&
      parent.page === snapshot.page &&
      sameBinding(parent.binding, snapshot.binding) &&
      snapshot.page.context() === owner.context &&
      snapshot.page.mainFrame() === snapshot.frame &&
      snapshot.page.url() === snapshot.url &&
      snapshot.frame.url() === snapshot.url &&
      current(owner) &&
      !parent.stopped &&
      parent.page === snapshot.page &&
      owner.record.tabs.get(snapshot.binding.tabId) === parent &&
      sameBinding(parent.binding, snapshot.binding)
    );
  } catch {
    return false;
  }
}

/** Shared first-commit observation; a second main-frame event never renews this capability. */
export function commitPopup(
  tab: TabRecord,
  page: Page,
  url: string,
  origin: string
): Promise<boolean> | null {
  const owner = owners.get(tab);
  if (!owner) return null;
  if (owner.phase !== 'pending') {
    refuse(owner);
    return Promise.resolve(false);
  }
  owner.phase = 'committing';
  owner.commitPending = true;
  owner.commit = owner.opener
    .then(async (parent) => {
      if (!owner.inputReady) {
        refuse(owner);
        return false;
      }
      try {
        await owner.viewportReady;
        await owner.inputReady;
      } catch {
        refuse(owner);
        return false;
      }
      let allowed = false;
      try {
        allowed =
          !!parent &&
          current(owner) &&
          page === owner.page &&
          page.context() === owner.context &&
          !parent.stopped &&
          owner.record.tabs.get(parent.binding.tabId) === parent &&
          performance.now() < owner.end &&
          owner.phase === 'committing' &&
          parentKnown(owner, parent) &&
          viewportKnown(owner) &&
          new URL(url).origin === owner.parent!.origin &&
          (origin === 'about:blank' || new URL(url).origin === origin) &&
          page.url() === url &&
          sameBinding(tab.binding, owner.initial) &&
          tab.captureSequence === 0 &&
          tab.pending === 0;
      } catch {
        /* Ambiguous or malformed native observation refuses. */
      }
      if (
        !allowed ||
        !current(owner) ||
        !parent ||
        !parentKnown(owner, parent) ||
        owner.phase !== 'committing'
      ) {
        refuse(owner);
        return false;
      }
      tab.binding = Object.freeze({
        ...owner.initial,
        navigationGeneration: advanceCounter(owner.initial.navigationGeneration),
      });
      owner.phase = 'committed';
      tab.diagnostics.replaceEpoch();
      return true;
    })
    .catch(() => {
      refuse(owner);
      return false;
    })
    .finally(() => {
      owner.commitPending = false;
      releaseObservation(owner);
    });
  return owner.commit;
}

/** No precommit input/reset/capture can enter the blank lifetime. */
export function popupPending(tab: TabRecord): boolean {
  const owner = owners.get(tab);
  return !!owner && owner.phase !== 'completed';
}
/** Trusted original input constructor enrolls before session acquisition/listener callbacks. */
export function registerPopupInput(
  tab: TabRecord,
  initial: BrowserBinding,
  input: object,
  ready: Promise<void>
): void {
  const owner = owners.get(tab);
  if (!owner) return;
  if (owner.input !== null || !current(owner) || !sameBinding(initial, owner.initial)) {
    refuse(owner);
    return;
  }
  owner.input = input;
  owner.originalReady = ready;
  owner.inputPending = true;
  owner.inputReady = ready.finally(() => {
    owner.inputPending = false;
    releaseObservation(owner);
  });
  void owner.inputReady.catch(() => {
    refuse(owner);
  });
}

/** Exact returned constructor facade, never a structural copy of its methods/readiness. */
export function registerPopupHandle(
  tab: TabRecord,
  input: object,
  handle: object,
  ready: Promise<void>
): void {
  const owner = owners.get(tab);
  if (!owner) return;
  if (
    owner.input !== input ||
    owner.handle !== null ||
    owner.originalReady !== ready ||
    !current(owner)
  ) {
    refuse(owner);
    return;
  }
  owner.handle = handle;
}

/** Pending admission can retain known originals; it does not authorize an input or capture. */
export function popupOwnsHandle(tab: TabRecord, handle: object): boolean {
  const owner = owners.get(tab);
  if (!owner || owner.handle !== handle || !pendingOriginal(owner)) return false;
  return true;
}

/** One final clock sample covers all captured pending originals after producer observations. */
export function popupCohortKnown(
  candidates: readonly { tab: TabRecord; handle: object }[]
): boolean {
  const originals = candidates.map(({ tab, handle }) => {
    const owner = owners.get(tab);
    return owner?.handle === handle && pendingOriginal(owner) ? owner : null;
  });
  if (originals.some((owner) => owner === null)) return false;
  const now = performance.now();
  for (const owner of originals) {
    if (!owner || now >= owner.end) {
      if (owner) refuse(owner);
      return false;
    }
  }
  return originals.every(
    (owner) =>
      !!owner &&
      owner.phase !== 'failed' &&
      owner.phase !== 'completed' &&
      ordinaryRecord(owner.record) &&
      owner.record.status === 'running' &&
      owner.record.browserGeneration === owner.initial.browserGeneration &&
      !owner.tab.stopped &&
      !owner.record.lifetime.gate.stopped &&
      owner.record.context === owner.context &&
      owner.record.tabs.get(owner.initial.tabId) === owner.tab &&
      owner.tab.page === owner.page &&
      sameBinding(owner.tab.binding, owner.initial)
  );
}

/** Constructor occurrence and fixed original admission window, without effect permission. */
export function popupOwnsInput(tab: TabRecord, input: object): boolean {
  const owner = owners.get(tab);
  return !!owner && owner.input === input && owner.handle !== null && pendingOriginal(owner);
}

function pendingOriginal(owner: Popup): boolean {
  const pending = () => owner.phase !== 'failed' && owner.phase !== 'completed';
  if (!pending()) return false;
  if (performance.now() >= owner.end) {
    refuse(owner);
    return false;
  }
  return (
    current(owner) &&
    owner.originalReady !== undefined &&
    owner.inputReady !== undefined &&
    owner.tab.captureSequence === 0 &&
    owner.tab.pending === 0 &&
    sameBinding(owner.tab.binding, owner.initial) &&
    pending()
  );
}

/** Publish admission only after the exact original input owner has installed its new binding. */
export function completePopupAdoption(
  tab: TabRecord,
  input: object,
  binding: BrowserBinding
): boolean {
  const owner = owners.get(tab);
  if (
    !owner ||
    owner.phase !== 'committed' ||
    !owner.parent ||
    !parentKnown(owner, owner.parent.tab) ||
    !viewportKnown(owner) ||
    owner.input !== input ||
    owner.adopted !== input ||
    !current(owner) ||
    !sameBinding(tab.binding, binding) ||
    performance.now() >= owner.end ||
    owner.phase !== 'committed' ||
    !current(owner)
  )
    return false;
  owner.phase = 'completed';
  clearTimeout(owner.timer);
  releaseObservation(owner);
  return true;
}
/** Exact original unentered input owner alone adopts the one returned generation. */
export function adoptPopup(
  tab: TabRecord,
  initial: BrowserBinding,
  input: object
): Promise<Readonly<BrowserBinding> | null> | null {
  const owner = owners.get(tab);
  if (!owner?.commit) return null;
  return owner.commit.then((committed) => {
    if (
      !committed ||
      !current(owner) ||
      owner.phase !== 'committed' ||
      !owner.parent ||
      !parentKnown(owner, owner.parent.tab) ||
      !viewportKnown(owner) ||
      owner.adopted !== null ||
      owner.input !== input ||
      !sameBinding(initial, owner.initial) ||
      !sameBinding(tab.binding, {
        ...owner.initial,
        navigationGeneration: advanceCounter(owner.initial.navigationGeneration),
      })
    )
      return null;
    owner.adopted = input;
    return Object.freeze({ ...tab.binding });
  });
}
