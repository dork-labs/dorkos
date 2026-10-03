/** Issue opaque acquisition certificates; observations cannot mint ownership. */
export class Ownership {
  #records = new WeakMap();
  #pids = new Map();
  constructor(run) {
    this.run = run;
    this.continuous = true;
    this.generation = 0;
  }
  acquire({ pid, uniqueId, tokenDigest, cohort, channel }) {
    if (
      !this.continuous ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      typeof uniqueId !== 'string' ||
      !/^[1-9][0-9]*$/.test(uniqueId) ||
      !/^[a-f0-9]{64}$/.test(tokenDigest) ||
      !['kernel', 'constructed'].includes(cohort) ||
      !channel ||
      this.#pids.has(pid)
    )
      throw Error('ACQUISITION_INVALID');
    const certificate = Object.freeze({});
    this.#records.set(certificate, {
      run: this.run,
      generation: ++this.generation,
      pid,
      uniqueId,
      tokenDigest,
      cohort,
      channel,
      state: 'live',
    });
    this.#pids.set(pid, certificate);
    return certificate;
  }
  observe(certificate, observation) {
    const record = this.#records.get(certificate);
    if (!record || record.state === 'reaped') throw Error('OWNERSHIP_REFUSED');
    if (
      observation.uniqueId !== record.uniqueId ||
      !['live', 'exited-unreaped'].includes(observation.state) ||
      observation.directChild !== true
    ) {
      record.state = 'unknown';
      throw Error('OWNERSHIP_UNKNOWN');
    }
    if (
      record.state === 'unknown' ||
      (record.state === 'exited-unreaped' && observation.state === 'live')
    )
      throw Error('OWNERSHIP_UNKNOWN');
    record.state = observation.state;
  }
  require(certificate, { allowExited = false } = {}) {
    const record = this.#records.get(certificate);
    if (
      !this.continuous ||
      !record ||
      !(record.state === 'live' || (allowExited && record.state === 'exited-unreaped'))
    )
      throw Error('OWNERSHIP_REFUSED');
    return Object.freeze({ ...record });
  }
  reap(certificate) {
    const record = this.#records.get(certificate);
    if (!record || record.state !== 'exited-unreaped') throw Error('REAP_REFUSED');
    record.state = 'reaped';
    this.#pids.delete(record.pid);
  }
  loseContinuity() {
    this.continuous = false;
  }
}
