import type { BrowserContext } from 'playwright-core';
import type { BrowserStopGate } from './stop.js';
import { createBrowserStopGate } from './stop.js';
import { sameBinding } from '../input/binding.js';
import type { BrowserRecord } from './records.js';
import type { InputOwnerSlot } from './input-owner.js';

/** Closed categories remain private to exact producer-owned lifetime composition. */
export type RetirementCause =
  | 'explicitStop'
  | 'disabled'
  | 'authorityRevoked'
  | 'engineFault'
  | 'persistenceFailure'
  | 'cleanupFailure';
export type CleanupUnknown =
  | 'permitUnavailable'
  | 'targetChanged'
  | 'clockUnavailable'
  | 'drainTimeout'
  | 'releaseTimeout'
  | 'custodyPending'
  | 'observationUnavailable';
export type CleanupObservation =
  | Readonly<{
      state: 'settled';
      binding: import('../contracts.js').BrowserBinding;
      drain: 'acknowledged';
      release: 'acknowledged';
      pending: false;
      uncertainty: false;
    }>
  | Readonly<{
      state: 'failed';
      binding: import('../contracts.js').BrowserBinding;
      reason: 'drainFailed' | 'releaseFailed';
      pending: boolean;
      uncertainty: true;
    }>
  | Readonly<{
      state: 'unverified';
      binding: import('../contracts.js').BrowserBinding;
      reason: CleanupUnknown;
      pending: boolean;
      uncertainty: true;
    }>
  | Readonly<{
      state: 'unverified';
      binding: null;
      reason: 'permitUnavailable' | 'clockUnavailable' | 'observationUnavailable';
      pending: boolean;
      uncertainty: true;
    }>;

/** Type identity alone is not authority: permits must occur in the owning cohort Map. */
const cleanupPermitBrand: unique symbol = Symbol('cleanup-permit');
export type CleanupPermit = Readonly<{ [cleanupPermitBrand]: true }>;
export interface CleanupAttempt {
  readonly identity: object;
  readonly kind: 'keyUp' | 'mouseUp' | 'cancelComposition' | 'cancelDrag';
  readonly step: import('../input/types.js').CleanupInputStep;
  operation: Promise<void> | null;
  entered: boolean;
  pending: boolean;
  acknowledged: boolean;
  uncertain: boolean;
}
export interface CleanupTarget {
  readonly record: BrowserRecord;
  readonly owner: InputOwnerSlot;
  readonly tab: import('./records.js').TabRecord;
  readonly page: import('./records.js').TabRecord['page'];
  readonly transport: object;
  readonly session: object;
  readonly binding: Readonly<import('../contracts.js').BrowserBinding>;
  readonly end: number;
}
export interface OwnerCleanupCohort {
  readonly identity: object;
  readonly owner: InputOwnerSlot;
  readonly tab: import('./records.js').TabRecord;
  readonly attempts: Map<object, CleanupAttempt>;
  readonly permits: Map<CleanupPermit, CleanupTarget>;
  target: CleanupTarget | null;
  observation: CleanupObservation | null;
}
export type AggregateCleanup =
  | Readonly<{ state: 'settled'; coverage: 'closed'; pending: false; uncertainty: readonly [] }>
  | Readonly<{
      state: 'failed' | 'unverified';
      coverage: 'closed' | 'unavailable';
      pending: boolean;
      uncertainty: readonly (CleanupUnknown | 'drainFailed' | 'releaseFailed')[];
    }>;
export type RetirementObservation = Readonly<{
  cleanup: AggregateCleanup;
  owners: readonly Readonly<{ identity: object; observation: CleanupObservation }>[];
  terminal: import('./records.js').CloseOutcome | Readonly<{ cleanup: 'notYetObserved' }>;
  firstCause: RetirementCause;
  uncertainty: readonly (
    | CleanupUnknown
    | 'drainFailed'
    | 'releaseFailed'
    | 'terminalCloseFailed'
    | 'persistenceUnknown'
    | 'invalidationUnknown'
  )[];
}>;
export interface RetirementSlot {
  readonly promise: Promise<RetirementObservation>;
  readonly complete: (result: RetirementObservation) => void;
  readonly cohorts: Map<InputOwnerSlot, OwnerCleanupCohort>;
  readonly pendingCoverage: Set<Promise<void>>;
  readonly missingOwners: Set<import('./records.js').TabRecord>;
  firstCause: RetirementCause | null;
  end: number | undefined;
  inputEnd: number | undefined;
  snapshotTaken: boolean;
  terminalEntered: boolean;
  driverEntered: boolean;
  coverageUnavailable: boolean;
  result: RetirementObservation | null;
  cleanupPromise: Promise<AggregateCleanup> | null;
}
export interface OrdinaryAdmissionCell {
  readonly browserId: string;
  readonly browserGeneration: number;
  readonly retirement: RetirementSlot;
  record: BrowserRecord | null;
  records: Map<string, BrowserRecord> | null;
  phase: 'ordinary' | 'retiring' | 'terminal';
  driver: (() => void) | null;
}

/** Exact parent custody; a deadline bounds waiting, never the underlying acquisition. */
export interface BrowserLifetime {
  readonly ordinary: OrdinaryAdmissionCell;
  readonly gate: BrowserStopGate;
  readonly inputs: Map<object, InputOwnerSlot>;
  readonly pending: Set<Promise<void>>;
  readonly contextCloses: Map<BrowserContext, Promise<void>>;
  readonly proxyCloses: Map<object, Promise<void>>;
  readonly requestRetirement: (cause: RetirementCause) => void;
  parentEnd?: number;
  inputEnd?: number;
  uncertain: boolean;
  closeFailed: boolean;
  releasePending: boolean;
}

/** Install before the first acquisition; absence is never inferred as empty ownership. */
export function createBrowserLifetime(browserId: string, generation: number): BrowserLifetime {
  let complete!: (result: RetirementObservation) => void;
  const promise = new Promise<RetirementObservation>((resolve) => {
    complete = resolve;
  });
  const retirement: RetirementSlot = {
    promise,
    complete,
    cohorts: new Map(),
    pendingCoverage: new Set(),
    missingOwners: new Set(),
    firstCause: null,
    end: undefined,
    inputEnd: undefined,
    snapshotTaken: false,
    terminalEntered: false,
    driverEntered: false,
    coverageUnavailable: false,
    result: null,
    cleanupPromise: null,
  };
  const ordinary: OrdinaryAdmissionCell = {
    browserId,
    browserGeneration: generation,
    retirement,
    record: null,
    records: null,
    phase: 'ordinary',
    driver: null,
  };
  return {
    ordinary,
    requestRetirement: (cause) => {
      const record = ordinary.record;
      if (!record) {
        retirement.coverageUnavailable = true;
        return;
      }
      requestRetirement(record, cause);
    },
    gate: createBrowserStopGate(browserId, generation),
    inputs: new Map(),
    pending: new Set(),
    contextCloses: new Map(),
    proxyCloses: new Map(),
    uncertain: false,
    closeFailed: false,
    releasePending: false,
  };
}

/** Bind once to the exact locally created record, before acquisition or external registration. */
export function bindOrdinaryRecord(
  record: BrowserRecord,
  records: Map<string, BrowserRecord>
): boolean {
  const cell = record.lifetime.ordinary;
  if (
    Map.prototype.get.call(records, record.browserId) !== record ||
    cell.record !== null ||
    cell.phase !== 'ordinary' ||
    cell.browserId !== record.browserId ||
    cell.browserGeneration !== record.browserGeneration
  )
    return false;
  cell.records = records;
  cell.record = record;
  return true;
}

/** No clock, method getter or callback: caller supplies the exact trusted local record. */
export function ordinaryRecord(record: BrowserRecord): boolean {
  const cell = record.lifetime.ordinary;
  return (
    cell.record === record &&
    cell.records !== null &&
    Map.prototype.get.call(cell.records, record.browserId) === record &&
    cell.phase === 'ordinary' &&
    cell.driver !== null &&
    cell.browserId === record.browserId &&
    cell.browserGeneration === record.browserGeneration
  );
}

/** Irreversible synchronous local fence; enumeration/drain/clock work follows separately. */
export function fenceOrdinary(
  record: BrowserRecord,
  cause: RetirementCause
): RetirementSlot | null {
  const cell = record.lifetime.ordinary;
  if (
    cell.record !== record ||
    cell.records === null ||
    Map.prototype.get.call(cell.records, record.browserId) !== record ||
    cell.browserId !== record.browserId ||
    cell.browserGeneration !== record.browserGeneration
  )
    return null;
  const slot = cell.retirement;
  if (cell.phase === 'ordinary') {
    slot.firstCause = cause;
    cell.phase = 'retiring';
  }
  return slot;
}

const captureSlots = new WeakSet<Promise<void>>();

/** Capture closed producer membership after fencing, before any external cleanup observation. */
export function snapshotRetirementOwners(record: BrowserRecord, slot: RetirementSlot): void {
  const cell = record.lifetime.ordinary;
  if (cell.record !== record || cell.phase !== 'retiring' || cell.retirement !== slot) return;
  if (slot.snapshotTaken) return;
  slot.snapshotTaken = true;
  for (const owner of record.lifetime.inputs.values()) {
    slot.cohorts.set(owner, {
      identity: Object.freeze({}),
      owner,
      tab: owner.tab,
      attempts: new Map(),
      permits: new Map(),
      target: null,
      observation: null,
    });
  }
  for (const tab of record.tabs.values()) {
    if (!record.lifetime.inputs.has(tab)) slot.missingOwners.add(tab);
  }
  for (const pending of record.lifetime.pending) slot.pendingCoverage.add(pending);
  // A constructing owner or pending duty is accounted as a gap until genuine exact settlement.
  slot.coverageUnavailable =
    slot.missingOwners.size !== 0 ||
    [...slot.pendingCoverage].some((pending) => !captureSlots.has(pending));
  // A generic Promise is not producer correspondence. Its later fulfillment does not close this gap.
}

/** Mint from producer-bound target only; never from request/serialized fields. */
export function issueCleanupPermit(
  record: BrowserRecord,
  owner: InputOwnerSlot
): CleanupPermit | null {
  const cell = record.lifetime.ordinary;
  const slot = cell.retirement;
  const cohort = slot.cohorts.get(owner);
  const target = cohort?.target;
  if (
    cell.record !== record ||
    cell.phase !== 'retiring' ||
    !slot.snapshotTaken ||
    !cohort ||
    !target ||
    target.record !== record ||
    target.owner !== owner ||
    target.tab !== owner.tab ||
    target.page !== owner.page ||
    target.page !== owner.tab.page ||
    owner.registeredTarget?.page !== target.page ||
    owner.registeredTarget.transport !== target.transport ||
    owner.registeredTarget.session !== target.session ||
    !sameBinding(target.tab.binding, target.binding) ||
    record.tabs.get(target.binding.tabId) !== target.tab ||
    record.lifetime.inputs.get(target.tab) !== owner ||
    record.lifetime.gate.stopped ||
    target.tab.stopped ||
    !Number.isFinite(target.end) ||
    target.end < 0 ||
    slot.inputEnd === undefined ||
    slot.end === undefined ||
    !Number.isFinite(slot.inputEnd) ||
    !Number.isFinite(slot.end) ||
    target.end > slot.inputEnd ||
    target.end > slot.end
  )
    return null;
  const prior = cohort.permits.keys().next().value;
  if (prior) return prior;
  const permit: CleanupPermit = Object.freeze({ [cleanupPermitBrand]: true as const });
  cohort.permits.set(permit, target);
  return permit;
}

/** One-use slot is owned before a native getter; final IO guards remain mandatory. */
export function enterCleanupAttempt(
  record: BrowserRecord,
  permit: CleanupPermit,
  attempt: CleanupAttempt
): CleanupTarget | null {
  const cell = record.lifetime.ordinary;
  if (cell.record !== record || cell.phase !== 'retiring' || record.lifetime.gate.stopped)
    return null;
  for (const cohort of cell.retirement.cohorts.values()) {
    const target = cohort.permits.get(permit);
    if (!target || cohort.target !== target || cohort.attempts.get(attempt.identity) !== attempt)
      continue;
    if (
      attempt.entered ||
      target.owner !== cohort.owner ||
      target.tab !== cohort.tab ||
      record.tabs.get(target.binding.tabId) !== target.tab ||
      record.lifetime.inputs.get(target.tab) !== cohort.owner ||
      target.tab.stopped ||
      target.page !== cohort.owner.page ||
      target.page !== target.tab.page ||
      cohort.owner.registeredTarget?.page !== target.page ||
      cohort.owner.registeredTarget.transport !== target.transport ||
      cohort.owner.registeredTarget.session !== target.session ||
      !sameBinding(target.tab.binding, target.binding)
    )
      return null;
    attempt.entered = true;
    attempt.pending = true;
    return target;
  }
  return null;
}

/** Register the unsettled slot before observing an external factory or invoking its method. */
export function ownOperation<T>(
  record: BrowserRecord,
  enter: () => T | PromiseLike<T>,
  accept?: (value: T) => void
): Promise<T> {
  return ownRegisteredOperation(record, enter, accept, false);
}

/** Exact capture work cannot acquire an owner; its original return closes only its own custody slot. */
export function ownCaptureOperation<T>(
  record: BrowserRecord,
  enter: () => T | PromiseLike<T>
): Promise<T> {
  return ownRegisteredOperation(record, enter, undefined, true);
}

function ownRegisteredOperation<T>(
  record: BrowserRecord,
  enter: () => T | PromiseLike<T>,
  accept: ((value: T) => void) | undefined,
  capture: boolean
): Promise<T> {
  const owner = record.lifetime;
  let settle!: () => void;
  const slot = new Promise<void>((done) => {
    settle = done;
  });
  if (capture) captureSlots.add(slot);
  owner.pending.add(slot);
  const done = () => {
    owner.pending.delete(slot);
    if (captureSlots.has(slot)) owner.ordinary.retirement.pendingCoverage.delete(slot);
    settle();
  };
  try {
    return Promise.resolve(enter()).then(
      (value) => {
        try {
          accept?.(value);
          return value;
        } finally {
          done();
        }
      },
      (error: unknown) => {
        done();
        throw error;
      }
    );
  } catch (error) {
    done();
    return Promise.reject(error);
  }
}

/** Attempt every exact owned close once, including handles returned after the parent wait. */
export function closeOwned(
  record: BrowserRecord,
  kind: 'context' | 'proxy',
  subject: BrowserContext | NonNullable<BrowserRecord['proxy']>
): Promise<void> {
  const owner = record.lifetime;
  const map: Map<object, Promise<void>> = kind === 'context'
    ? owner.contextCloses
    : owner.proxyCloses;
  const prior = map.get(subject);
  if (prior) return prior;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const shared = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  map.set(subject, shared);
  void shared.catch(() => {});
  void ownOperation(record, async () => {
    if (kind === 'context' && record.supervisor) await record.controllerCloseBarrier;
    // The supervisor owns persistent-context termination. The controller owns only its
    // public CDP connection; closing the default context here would race that owner.
    const resource =
      kind === 'context' && record.supervisor && record.controllerBrowser
        ? record.controllerBrowser
        : subject;
    const call = resource.close;
    return Reflect.apply(call, resource, []) as Promise<void>;
  }).then(resolve, (error: unknown) => {
    owner.closeFailed = true;
    reject(error);
  });
  return shared;
}

/** Late context possession cannot grant attribution rights or replace an installed close result. */
export function acceptContext(record: BrowserRecord, context: BrowserContext): void {
  record.context = context;
  if (record.status !== 'opening' || record.lifetime.gate.stopped) {
    record.lifetime.uncertain = true;
    void closeOwned(record, 'context', context).catch(() => {});
  }
}

/** Enter every captured exact cohort before awaiting any owner; never replay its installed drain. */
export function drainRetirement(
  record: BrowserRecord,
  slot: RetirementSlot
): Promise<AggregateCleanup> {
  if (slot.cleanupPromise) return slot.cleanupPromise;
  let complete!: (value: AggregateCleanup) => void;
  slot.cleanupPromise = new Promise((done) => {
    complete = done;
  });
  // Only original capture slots have known nonacquiring producer correspondence.
  // The unchanged parent deadline bounds this join; unknown acquisition remains a sticky gap.
  const operations: Promise<void>[] = [...slot.pendingCoverage].filter((pending) =>
    captureSlots.has(pending)
  );
  for (const cohort of slot.cohorts.values()) {
    const owner = cohort.owner;
    const unknown = () => {
      owner.uncertain = true;
      cohort.observation = Object.freeze({
        state: 'unverified',
        binding: null,
        reason: 'observationUnavailable',
        pending: true,
        uncertainty: true,
      });
    };
    let resolve!: () => void;
    const accounting = new Promise<void>((done) => {
      resolve = done;
    });
    operations.push(accounting);
    try {
      // The receiver/function were captured by the exact composeInput producer, not retirement input.
      const retire = owner.retireOwner;
      if (
        !retire ||
        owner.constructing ||
        !owner.registeredTarget ||
        owner.registeredTarget.page !== owner.page ||
        cohort.tab.page !== owner.page ||
        slot.inputEnd === undefined ||
        !Number.isFinite(slot.inputEnd) ||
        record.lifetime.ordinary.phase !== 'retiring' ||
        record.lifetime.inputs.get(cohort.tab) !== owner ||
        record.tabs.get(cohort.tab.binding.tabId) !== cohort.tab
      )
        throw new Error('RETIREMENT_OWNER_UNAVAILABLE');
      const operation = owner.retirement ?? retire(slot.inputEnd);
      owner.retirement = operation;
      void operation.then(
        (observation) => {
          cohort.observation = observation;
          resolve();
        },
        () => {
          unknown();
          resolve();
        }
      );
    } catch {
      unknown();
      resolve();
    }
  }
  // No wait can authorize a new owner. Generic pending acquisition coverage remains unavailable.
  void Promise.all(operations).then(() => complete(aggregateRetirement(record, slot)));
  return slot.cleanupPromise;
}

/** Closed categories and frozen snapshots; late ACK cannot mutate an already sealed aggregate. */
export function aggregateRetirement(record: BrowserRecord, slot: RetirementSlot): AggregateCleanup {
  const reasons = new Set<CleanupUnknown | 'drainFailed' | 'releaseFailed'>();
  let pending = slot.pendingCoverage.size !== 0,
    failed = false;
  const closed = slot.snapshotTaken && !slot.coverageUnavailable && slot.missingOwners.size === 0;
  if (!closed) reasons.add('observationUnavailable');
  for (const cohort of slot.cohorts.values()) {
    const observation = cohort.observation;
    if (!observation) {
      pending = true;
      reasons.add('custodyPending');
      continue;
    }
    if (observation.state !== 'settled') {
      pending ||= observation.pending;
      reasons.add(observation.reason);
      failed ||= observation.state === 'failed';
    }
    // A settled wrapper cannot erase an exact owner/attempt's retained uncertainty.
    if (cohort.owner.uncertain) reasons.add('observationUnavailable');
    for (const attempt of cohort.attempts.values()) {
      pending ||= attempt.pending;
      if (!attempt.entered || !attempt.acknowledged || attempt.uncertain)
        reasons.add('releaseTimeout');
    }
  }
  if (pending) reasons.add('custodyPending');
  if (record.lifetime.uncertain) reasons.add('observationUnavailable');
  if (closed && !pending && reasons.size === 0)
    return Object.freeze({
      state: 'settled',
      coverage: 'closed',
      pending: false,
      uncertainty: Object.freeze([]) as readonly [],
    });
  return Object.freeze({
    state: failed ? 'failed' : 'unverified',
    coverage: closed ? 'closed' : 'unavailable',
    pending,
    uncertainty: Object.freeze([...reasons]),
  });
}

/** Terminal result is separate from cleanup. Completion is one-shot and never heals prior uncertainty. */
export function finishRetirement(
  record: BrowserRecord,
  slot: RetirementSlot,
  cleanup: AggregateCleanup,
  terminal: import('./records.js').CloseOutcome
): void {
  if (slot.result) return;
  const owners = [...slot.cohorts.values()].map((cohort) =>
    Object.freeze({
      identity: cohort.identity,
      observation:
        cohort.observation ??
        Object.freeze({
          state: 'unverified' as const,
          binding: null,
          reason: 'observationUnavailable' as const,
          pending: true,
          uncertainty: true as const,
        }),
    })
  );
  const uncertainty: RetirementObservation['uncertainty'][number][] = [...cleanup.uncertainty];
  if (terminal.cleanup !== 'observed') uncertainty.push('terminalCloseFailed');
  slot.result = Object.freeze({
    cleanup,
    owners: Object.freeze(owners),
    terminal,
    firstCause: slot.firstCause ?? 'engineFault',
    uncertainty: Object.freeze(uncertainty),
  });
  record.lifetime.ordinary.phase = 'terminal';
  slot.complete(slot.result);
}

/** Install once from the exact local engine producer before any fallible acquisition. */
export function installRetirementDriver(record: BrowserRecord, driver: () => void): boolean {
  const cell = record.lifetime.ordinary;
  if (
    cell.record !== record ||
    !cell.records ||
    Map.prototype.get.call(cell.records, record.browserId) !== record ||
    cell.phase !== 'ordinary' ||
    cell.driver !== null
  )
    return false;
  cell.driver = driver;
  return true;
}

/** Preinstalled synchronous fence/cause first; only then invoke the captured parent receiver. */
export function requestRetirement(record: BrowserRecord, cause: RetirementCause): void {
  const slot = fenceOrdinary(record, cause);
  if (!slot) {
    record.lifetime.uncertain = true;
    return;
  }
  const driver = record.lifetime.ordinary.driver;
  if (!driver) {
    record.lifetime.uncertain = true;
    slot.coverageUnavailable = true;
    return;
  }
  if (slot.driverEntered) return;
  slot.driverEntered = true;
  try {
    Reflect.apply(driver, undefined, []);
  } catch {
    record.lifetime.uncertain = true;
    slot.coverageUnavailable = true;
  }
}
