import { performance } from 'node:perf_hooks';
import { CohortBudget, COHORTS } from './cohort-budget.mjs';
import { closedRecord } from './framing.mjs';
import { LIMITS, PINS } from './policy.mjs';

function errorCode(error, fallback) {
  try {
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    return message &&
      'value' in message &&
      typeof message.value === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(message.value)
      ? message.value
      : fallback;
  } catch {
    return fallback;
  }
}

const RESULT_KEYS = [
  'cohort',
  'status',
  'reason',
  'fixtureSubjects',
  'identityQueries',
  'censusCalls',
  'exitRegistrations',
  'exitEvents',
  'signals',
  'deliveries',
  'refusals',
  'terminations',
  'coverage',
];
function exerciseResult(value, allocation) {
  closedRecord(value, RESULT_KEYS);
  if (
    value.cohort !== allocation.id ||
    !['observed', 'unverified', 'failed'].includes(value.status) ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.reason) ||
    !['continuous', 'lost', 'unknown'].includes(value.coverage)
  )
    throw Error('GUARDIAN_RESULT_SCHEMA');
  for (const key of [
    'fixtureSubjects',
    'identityQueries',
    'censusCalls',
    'exitRegistrations',
    'exitEvents',
    'signals',
    'deliveries',
    'refusals',
    'terminations',
  ])
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw Error('GUARDIAN_RESULT_SCHEMA');
  if (
    value.fixtureSubjects > allocation.acquisitions - 1 ||
    value.signals > allocation.signals ||
    value.deliveries + value.refusals + value.terminations > value.signals ||
    value.identityQueries > 128
  )
    throw Error('GUARDIAN_RESULT_COUNTS');
  if (value.coverage !== 'continuous' && value.status === 'observed')
    throw Error('COVERAGE_FALSE_SUCCESS');
  return Object.freeze({ ...value });
}
function closureResult(value) {
  closedRecord(value, [
    'guardianReaped',
    'slotsClosed',
    'channelsClosed',
    'custodyContinuous',
    'registeredExitComplete',
  ]);
  if (Object.values(value).some((field) => typeof field !== 'boolean'))
    throw Error('CLOSURE_SCHEMA');
  return Object.values(value).every((field) => field === true);
}

/** Run isolated cohorts against an injected trusted guardian transport; never native proof by itself. */
export class CohortRunner {
  #slots = [];
  #closing;
  #running;
  #hostCleanupEnd = null;
  constructor({
    guardianFactory,
    registerCleanup,
    now = () => performance.now(),
    timers = { setTimeout, clearTimeout },
  }) {
    if (typeof guardianFactory !== 'function' || typeof registerCleanup !== 'function')
      throw Error('RUN_PORTS_REQUIRED');
    this.factory = guardianFactory;
    this.now = now;
    this.timers = timers;
    this.budget = new CohortBudget(now);
    this.results = [];
    this.events = [];
    this.reason = null;
    this.closed = false;
    if (registerCleanup(() => this.close()) !== true) throw Error('CLEANUP_NOT_REGISTERED');
  }
  async #bounded(work, end, cleanup = false) {
    let timer;
    const remaining = Math.max(
      0,
      cleanup ? this.#hostCleanupEnd - performance.now() : end - this.budget.time()
    );
    if (!remaining) throw Error('DEADLINE_EXCEEDED');
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = this.timers.setTimeout(() => reject(Error('DEADLINE_EXCEEDED')), remaining);
        }),
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }
  run() {
    this.#running ??= this.#run();
    return this.#running;
  }
  async #run() {
    try {
      for (const cohort of COHORTS) {
        if (this.closed) throw Error('RUN_CLOSED');
        const allocation = this.budget.open(cohort);
        const slot = {
          allocation,
          guardian: null,
          retired: false,
          closure: null,
          acquisition: null,
          closed: null,
          abort: new AbortController(),
        };
        // Retain a slot and cleanup before the factory can create a native or simulated child.
        this.#slots.push(slot);
        this.budget.acquire(allocation);
        this.events.push(Object.freeze({ type: 'guardian-intent', cohort: cohort.id }));
        slot.acquisition = Promise.resolve().then(() => {
          const factory = this.factory;
          const current = this.budget.time();
          this.budget.assertAdmission(allocation);
          // Method capture and the clock are external observations; neither may renew admission.
          if (
            this.closed ||
            this.budget.stopped ||
            this.budget.clockUnverified ||
            current >= allocation.end ||
            slot.retired ||
            slot.abort.signal.aborted
          )
            throw Error('COHORT_ADMISSION_CLOSED');
          return Reflect.apply(factory, this, [
            allocation,
            (guardian) => {
              if (slot.guardian) throw Error('GUARDIAN_DUPLICATE');
              slot.guardian = guardian;
              if (slot.retired || this.closed) {
                this.events.push(Object.freeze({ type: 'late-guardian', cohort: cohort.id }));
                return this.#closeSlot(slot, this.budget.faultCleanupEnd(), true);
              }
              return true;
            },
            { signal: slot.abort.signal },
          ]);
        });
        slot.acquisition.catch(() => {});
        await this.#bounded(
          () => slot.acquisition,
          Math.min(allocation.end, this.now() + LIMITS.startupMs)
        );
        if (this.closed || slot.retired || !slot.guardian)
          throw Error('GUARDIAN_STARTUP_UNVERIFIED');
        const result = exerciseResult(
          await this.#bounded(() => {
            if (this.closed || slot.retired || slot.abort.signal.aborted)
              throw Error('COHORT_ADMISSION_CLOSED');
            const guardian = slot.guardian;
            const exercise = guardian.exercise;
            const current = this.budget.time();
            this.budget.assertAdmission(allocation);
            if (
              this.closed ||
              this.budget.stopped ||
              this.budget.clockUnverified ||
              current >= allocation.end ||
              slot.retired ||
              slot.abort.signal.aborted ||
              slot.guardian !== guardian ||
              slot.allocation !== allocation
            )
              throw Error('COHORT_ADMISSION_CLOSED');
            return Reflect.apply(exercise, guardian, [allocation]);
          }, allocation.end),
          allocation
        );
        // The trusted guardian separately enforces this fixed allocation before every child/call.
        for (let i = 0; i < result.fixtureSubjects; i++) this.budget.acquire(allocation);
        for (let i = 0; i < result.signals; i++) this.budget.signal(allocation);
        this.results.push(result);
        this.budget.closeAdmission(allocation);
        const closed = await this.#closeSlot(slot, allocation.end);
        if (!closed) throw Error('CUSTODY_UNKNOWN');
        for (let i = 0; i <= result.fixtureSubjects; i++) this.budget.gone(allocation);
        this.budget.finish(allocation, true);
        if (result.status === 'failed' || result.coverage === 'unknown') throw Error(result.reason);
        // Coverage loss never becomes an observed result; a fresh cohort requires its own closed custody proof.
      }
    } catch (error) {
      this.budget.stop();
      const reason = errorCode(error, 'RUN_UNVERIFIED');
      this.reason ??= reason;
    }
    if (!this.reason && !this.closed) {
      this.closed = true;
      this.budget.stop();
      this.#closing = this.#closeAll(this.budget.end);
    }
    return this.close();
  }
  #closeSlot(slot, end, cleanup = false) {
    if (slot.closed) return slot.closed;
    const work = Promise.resolve().then(() =>
      slot.guardian.close({
        end: cleanup && this.budget.clockUnverified ? this.#hostCleanupEnd : end,
      })
    );
    work.catch(() => {});
    slot.closed = this.#bounded(() => work, end, cleanup).then(
      (value) => {
        try {
          const complete = closureResult(value);
          slot.closure = value;
          return !slot.retired && complete;
        } catch {
          slot.closure = { reason: 'CLEANUP_UNVERIFIED' };
          return false;
        }
      },
      (error) => {
        slot.closure = {
          reason: errorCode(error, 'CLEANUP_UNVERIFIED'),
        };
        return false;
      }
    );
    return slot.closed;
  }
  close() {
    if (!this.#closing) {
      let complete;
      let fail;
      // Publish the shared cleanup handle before abort/guardian callbacks can reenter.
      this.#closing = new Promise((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      this.closed = true;
      this.#hostCleanupEnd = performance.now() + LIMITS.cleanupMs;
      const end = this.budget.faultCleanupEnd();
      for (const slot of this.#slots) {
        slot.retired = !slot.guardian;
        slot.abort.abort();
      }
      void this.#closeAll(end, true).then(complete, fail);
    }
    return this.#closing;
  }
  async #closeAll(end, cleanup = false) {
    for (const slot of [...this.#slots].reverse()) {
      if (!slot.guardian) {
        try {
          await this.#bounded(() => slot.acquisition, end, cleanup);
        } catch {
          /* Retired late arrivals remain cleanup-only. */
        }
      }
      if (slot.guardian) await this.#closeSlot(slot, end, cleanup);
    }
    try {
      this.budget.time();
    } catch {
      // Observation failure remains uncertainty even when owned cooperative cleanup fulfilled.
    }
    return Object.freeze({
      kind: 'injected-portable',
      pins: PINS,
      nativeSubjects: 0,
      nativeSignals: 0,
      nativeStatus: 'unverified',
      completeness: 'unverified',
      reason: this.reason,
      cleanupCauses: Object.freeze(this.budget.clockUnverified ? ['CLOCK_UNVERIFIED'] : []),
      simulatedAcquisitionIntents: this.budget.acquisitions,
      simulatedSignals: this.budget.signals,
      results: Object.freeze([...this.results]),
      cleanup: Object.freeze(
        this.#slots.map((slot) =>
          Object.freeze({
            cohort: slot.allocation.id,
            closure: slot.closure,
            retired: slot.retired,
          })
        )
      ),
      events: Object.freeze([...this.events]),
    });
  }
}
