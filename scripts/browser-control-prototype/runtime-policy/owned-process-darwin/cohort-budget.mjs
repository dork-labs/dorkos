import { LIMITS } from './policy.mjs';

/** Frozen isolated cohorts; these allocations are upper bounds, never observed sample counts. */
export const COHORTS = Object.freeze(
  [
    ['C1', 5, 14, 24_000],
    ['C2', 4, 1, 12_000],
    ['C3', 3, 1, 10_000],
    ['C4', 3, 0, 8_000],
    ['C5', 4, 0, 12_000],
    ['C6', 2, 0, 16_000],
  ].map(([id, acquisitions, signals, phaseMs]) =>
    Object.freeze({ id, acquisitions, signals, phaseMs })
  )
);

/** Maintain one nonrenewable aggregate ledger across guardians, including R itself. */
export class CohortBudget {
  #last;
  #active = null;
  #next = 0;
  #faultEnd = null;
  constructor(now) {
    this.now = now;
    this.start = now();
    if (!Number.isFinite(this.start)) throw Error('CLOCK_UNVERIFIED');
    this.#last = this.start;
    this.end = this.start + LIMITS.runMs;
    this.acquisitions = 1;
    this.live = 1;
    this.signals = 0;
    this.cleanupSignals = 0;
    this.stopped = false;
    this.clockUnverified = false;
  }
  time() {
    let now;
    try {
      now = this.now();
    } catch {
      now = NaN;
    }
    if (!Number.isFinite(now) || now < this.#last) {
      this.stop();
      this.clockUnverified = true;
      throw Error('CLOCK_UNVERIFIED');
    }
    this.#last = now;
    return now;
  }
  open(cohort) {
    const now = this.time();
    if (this.stopped || this.#active || cohort !== COHORTS[this.#next] || now >= this.end)
      throw Error('COHORT_ADMISSION_CLOSED');
    if (this.acquisitions + cohort.acquisitions > LIMITS.acquisitions)
      throw Error('ACQUISITION_CAP');
    const allocation = Object.freeze({ ...cohort, end: Math.min(this.end, now + cohort.phaseMs) });
    this.#active = { allocation, acquisitions: 0, signals: 0, admission: true };
    return allocation;
  }
  assertAdmission(allocation) {
    this.#require(allocation);
  }
  acquire(allocation) {
    const active = this.#require(allocation);
    if (active.acquisitions >= allocation.acquisitions || this.live >= LIMITS.live)
      throw Error('ACQUISITION_CAP');
    active.acquisitions++;
    this.acquisitions++;
    this.live++;
  }
  signal(allocation) {
    const active = this.#require(allocation);
    if (active.signals >= allocation.signals || this.signals >= LIMITS.signals - 8)
      throw Error('SIGNAL_CAP');
    active.signals++;
    this.signals++;
  }
  closeAdmission(allocation) {
    if (this.#active?.allocation !== allocation) throw Error('COHORT_BINDING');
    this.#active.admission = false;
  }
  gone(allocation) {
    if (this.#active?.allocation !== allocation || this.live <= 1) throw Error('CUSTODY_UNKNOWN');
    this.live--;
  }
  finish(allocation, closure) {
    if (this.#active?.allocation !== allocation || closure !== true || this.live !== 1) {
      this.stop();
      throw Error('CUSTODY_UNKNOWN');
    }
    this.#active = null;
    this.#next++;
  }
  stop() {
    this.stopped = true;
    if (this.#active) this.#active.admission = false;
  }
  faultCleanupEnd() {
    this.stop();
    if (this.#faultEnd === null) {
      try {
        this.#faultEnd = this.time() + LIMITS.cleanupMs;
      } catch {
        // Retain the last observation deadline; only the runner's host timer bounds attempts.
        this.#faultEnd = this.#last + LIMITS.cleanupMs;
      }
    }
    return this.#faultEnd;
  }
  cleanupSignal() {
    if (this.clockUnverified) throw Error('CLOCK_UNVERIFIED');
    const now = this.time();
    const end = this.faultCleanupEnd();
    // The observation callback can itself record irreversible uncertainty before returning.
    if (this.clockUnverified) throw Error('CLOCK_UNVERIFIED');
    if (now >= end || this.cleanupSignals >= 8 || this.signals >= LIMITS.signals)
      throw Error('CLEANUP_SIGNAL_CAP');
    this.cleanupSignals++;
    this.signals++;
  }
  #require(allocation) {
    const active = this.#active;
    if (
      this.stopped ||
      this.clockUnverified ||
      active?.allocation !== allocation ||
      !active.admission
    )
      throw Error('COHORT_ADMISSION_CLOSED');
    const now = this.time();
    // Clock callbacks can retire this allocation or record permanent uncertainty synchronously.
    if (
      this.stopped ||
      this.clockUnverified ||
      this.#active !== active ||
      active.allocation !== allocation ||
      !active.admission ||
      now >= allocation.end
    )
      throw Error('COHORT_ADMISSION_CLOSED');
    return active;
  }
}
