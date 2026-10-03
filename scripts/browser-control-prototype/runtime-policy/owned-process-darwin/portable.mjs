import { Budget, LIMITS, PINS } from './policy.mjs';
import { Ownership } from './ownership.mjs';
import { AckOracle } from './ack.mjs';

/** Exercise injected portable fixtures only; this module has no native acquisition path. */
export class PortableExperiment {
  #cleanups = [];
  #closePromise;
  #cleanupStart;
  constructor({ now, registerCleanup, run = 'portable', timers = { setTimeout, clearTimeout } }) {
    if (typeof registerCleanup !== 'function') throw Error('CLEANUP_REQUIRED');
    this.now = now;
    this.timers = timers;
    this.budget = new Budget(now);
    this.ownership = new Ownership(run);
    this.acks = new AckOracle(now);
    this.events = [];
    this.closed = false;
    this.registration = registerCleanup(() => this.close());
    if (this.registration !== true) throw Error('CLEANUP_NOT_REGISTERED');
  }
  async bounded(work, milliseconds) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = this.timers.setTimeout(() => reject(Error('DEADLINE_EXCEEDED')), milliseconds);
        }),
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }
  async acquire(acquireFixture) {
    if (this.closed) throw Error('RUN_STOPPED');
    this.budget.acquire();
    const slot = {
      fixture: null,
      certificate: null,
      gone: false,
      retired: false,
      settled: false,
      abort: new AbortController(),
      closePromise: null,
    };
    this.#cleanups.push(slot);
    this.events.push({ type: 'acquisition-intent', ordinal: this.budget.acquisitions });
    const start = this.now();
    slot.acquisition = Promise.resolve()
      .then(() => {
        const acquire = acquireFixture;
        const current = this.budget.check();
        if (
          this.closed ||
          this.budget.stopped ||
          slot.retired ||
          slot.abort.signal.aborted ||
          !Number.isFinite(start) ||
          current - start >= LIMITS.startupMs
        )
          throw Error('RUN_STOPPED');
        return Reflect.apply(acquire, undefined, [
          (fixture) => {
            if (slot.fixture) throw Error('ACQUISITION_DUPLICATE');
            slot.fixture = fixture;
            if (slot.retired || this.closed) {
              this.events.push({
                type: 'late-acquisition',
                ordinal: this.#cleanups.indexOf(slot) + 1,
              });
              return this.#closeSlot(slot);
            }
            slot.certificate = this.ownership.acquire(fixture);
            return slot.certificate;
          },
          { signal: slot.abort.signal },
        ]);
      })
      .finally(() => {
        slot.settled = true;
      });
    // Keep the underlying transport observed even after its acquisition deadline wins.
    slot.acquisition.catch(() => {});
    try {
      await this.bounded(() => slot.acquisition, LIMITS.startupMs);
      if (!slot.fixture || this.now() - start >= LIMITS.startupMs)
        throw Error('STARTUP_UNVERIFIED');
      this.budget.check();
      return slot.certificate;
    } catch (error) {
      slot.retired = true;
      slot.abort.abort();
      this.budget.stop();
      this.#cleanupStart ??= this.now();
      this.events.push({ type: 'acquisition-failure', code: error.message });
      if (slot.fixture) this.#closeSlot(slot);
      throw error;
    }
  }
  async signal(certificate, request) {
    try {
      return await this.signalCurrent(certificate, request);
    } catch (error) {
      this.budget.stop();
      this.events.push({ type: 'signal-failure', code: error.message });
      throw error;
    }
  }
  async signalCurrent(certificate, request) {
    const binding = this.ownership.require(certificate, { allowExited: request.exited === true });
    this.budget.check();
    const fixture = this.#cleanups.find((slot) => slot.certificate === certificate)?.fixture;
    if (!fixture) throw Error('OWNERSHIP_REFUSED');
    // A fresh direct-child observation is mandatory; adapter uncertainty never permits a call.
    this.ownership.observe(
      certificate,
      await this.bounded(() => fixture.observe(), LIMITS.startupMs)
    );
    this.ownership.require(certificate, { allowExited: request.exited === true });
    this.budget.signal();
    return this.bounded(() => {
      const signal = fixture.signal;
      this.budget.check();
      this.ownership.require(certificate, { allowExited: request.exited === true });
      // No external observation follows this final admission check before native-port entry.
      if (this.closed || this.budget.stopped) throw Error('RUN_STOPPED');
      return Reflect.apply(signal, fixture, [request, binding]);
    }, LIMITS.ackMs);
  }
  close() {
    if (!this.#closePromise) {
      let complete, fail;
      // Install the whole-run handle before clock/abort callbacks may reenter.
      this.#closePromise = new Promise((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      this.closed = true;
      this.budget.stop();
      this.ownership.loseContinuity();
      try {
        this.#cleanupStart ??= this.now();
        for (const slot of this.#cleanups) {
          if (!slot.settled) slot.retired = true;
          slot.abort.abort();
        }
        void Promise.resolve()
          .then(() => this.#closeAll())
          .then(complete, fail);
      } catch (error) {
        fail(error);
      }
    }
    return this.#closePromise;
  }
  #remaining() {
    const elapsed = this.now() - this.#cleanupStart;
    return Number.isFinite(elapsed) && elapsed >= 0 ? Math.max(0, LIMITS.cleanupMs - elapsed) : 0;
  }
  #closeSlot(slot) {
    if (slot.closePromise) return slot.closePromise;
    this.#cleanupStart ??= this.now();
    // Always request cooperative exit, including a fixture delivered after cleanup expired.
    // That late request never upgrades the retired acquisition's uncertainty.
    const work = Promise.resolve()
      .then(() => slot.fixture.close({ deadline: this.#cleanupStart + LIMITS.cleanupMs }))
      .then((result) => {
        if (result?.status === 'gone' && !slot.gone) {
          this.budget.gone();
          slot.gone = true;
        }
        return result;
      });
    const remaining = this.#remaining();
    slot.closePromise = this.bounded(() => work, remaining).then(
      (result) => {
        if (slot.retired || remaining <= 0 || this.#remaining() <= 0 || result?.status !== 'gone')
          return {
            status: 'unverified',
            reason: slot.retired ? 'acquisitionRetired' : 'CLEANUP_UNVERIFIED',
          };
        return { status: 'gone' };
      },
      (error) => ({ status: 'unverified', reason: error.message })
    );
    return slot.closePromise;
  }
  async #closeAll() {
    const results = [];
    for (const slot of [...this.#cleanups].reverse()) {
      if (!slot.fixture && !slot.settled) {
        try {
          await this.bounded(() => slot.acquisition, this.#remaining());
        } catch {
          /* Retired acquisitions stay observed; a late record receives its own close. */
        }
      }
      if (slot.fixture) results.push(await this.#closeSlot(slot));
      else results.push({ status: 'unverified', reason: 'acquisitionUnavailable' });
    }
    this.receipt = Object.freeze({
      kind: 'portable',
      pins: PINS,
      nativeSubjects: 0,
      nativeStatus: 'unverified',
      completeness: 'unverified',
      acquisitions: this.budget.acquisitions,
      signals: this.budget.signals,
      cleanup: results,
      events: [...this.events],
    });
    return this.receipt;
  }
}
