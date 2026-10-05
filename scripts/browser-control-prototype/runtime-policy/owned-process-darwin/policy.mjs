/** Frozen research limits; none authorizes acquiring a native subject. */
export const LIMITS = Object.freeze({
  acquisitions: 24,
  live: 8,
  signals: 24,
  runMs: 90_000,
  cleanupMs: 20_000,
  startupMs: 2000,
  ackMs: 1000,
  fixtureMs: 15_000,
});
/** Reviewed plan and published source pins; source is not an installed-kernel match. */
export const PINS = Object.freeze({
  plan: '17f06f26a4a34d7988e0b5941de2e916eab938cf2ccf161a2a24e03210cfdd4a',
  xnu: 'f6217f891ac0bb64f3d375211650a4c1ff8ca1ea',
});

/** Enforce irreversible per-run caps with an injected monotonic clock. */
export class Budget {
  constructor(now) {
    this.now = now;
    this.start = now();
    this.last = this.start;
    this.acquisitions = 0;
    this.live = 0;
    this.signals = 0;
    this.stopped = false;
  }
  check() {
    const time = this.now();
    if (!Number.isFinite(time) || time < this.last) this.stopped = true;
    this.last = time;
    if (this.stopped || time - this.start >= LIMITS.runMs) {
      this.stopped = true;
      throw Error('RUN_STOPPED');
    }
    return time;
  }
  acquire() {
    this.check();
    if (this.acquisitions >= LIMITS.acquisitions || this.live >= LIMITS.live) {
      this.stopped = true;
      throw Error('ACQUISITION_CAP');
    }
    this.acquisitions++;
    this.live++;
  }
  signal() {
    this.check();
    if (this.signals >= LIMITS.signals) {
      this.stopped = true;
      throw Error('SIGNAL_CAP');
    }
    this.signals++;
  }
  gone() {
    if (this.live < 1) throw Error('LIVE_COUNT_UNDERFLOW');
    this.live--;
  }
  stop() {
    this.stopped = true;
  }
}
