import { randomBytes, randomUUID } from 'node:crypto';
import { LIMITS } from './policy.mjs';

const KEYS = [
  'run',
  'cohort',
  'attempt',
  'generation',
  'pid',
  'tokenDigest',
  'challenge',
  'counter',
  'type',
];
function equal(message, expected) {
  if (
    !message ||
    Object.getPrototypeOf(message) !== Object.prototype ||
    Reflect.ownKeys(message).length !== KEYS.length
  )
    return false;
  return KEYS.every((key) => {
    const d = Object.getOwnPropertyDescriptor(message, key);
    return d && 'value' in d && d.value === expected[key];
  });
}

/** Validate ACKs against one exclusive channel, fresh challenge and bounded attempt. */
export class AckOracle {
  #pending = new Map();
  constructor(now) {
    this.now = now;
  }
  begin(binding, baseline) {
    const channel = binding.channel;
    if (
      this.#pending.has(channel) ||
      !Number.isSafeInteger(baseline) ||
      baseline < 0 ||
      baseline >= Number.MAX_SAFE_INTEGER
    )
      throw Error('ARM_REFUSED');
    const expected = Object.freeze({
      run: binding.run,
      cohort: binding.cohort,
      attempt: randomUUID(),
      generation: binding.generation,
      pid: binding.pid,
      tokenDigest: binding.tokenDigest,
      challenge: randomBytes(32).toString('hex'),
      counter: baseline,
      type: 'armed',
    });
    const start = this.now();
    if (this.#pending.has(channel)) throw Error('ARM_REFUSED');
    this.#pending.set(channel, { expected, start, armed: false, sent: false });
    return expected;
  }
  #current(channel, pending = this.#pending.get(channel)) {
    const elapsed = pending ? this.now() - pending.start : NaN;
    // An observation may cancel or replace this exact attempt. Never retire its successor.
    if (this.#pending.get(channel) !== pending) throw Error('ACK_EXPIRED');
    if (!pending || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= LIMITS.ackMs) {
      this.#pending.delete(channel);
      throw Error('ACK_EXPIRED');
    }
    return pending;
  }
  armed(channel, message) {
    const pending = this.#current(channel);
    if (pending.armed || !equal(message, pending.expected)) throw Error('ACK_REFUSED');
    this.#current(channel, pending);
    pending.armed = true;
  }
  sent(channel, apiResult) {
    const pending = this.#current(channel);
    if (!pending.armed || pending.sent) throw Error('SIGNAL_NOT_ARMED');
    const successful = apiResult?.status === 'success' && apiResult.raw === 0;
    this.#current(channel, pending);
    if (!successful) {
      this.#pending.delete(channel);
      throw Error('API_NOT_SUCCESS');
    }
    pending.sent = true;
  }
  delivered(channel, message) {
    const pending = this.#current(channel);
    if (
      !pending.sent ||
      !equal(message, {
        ...pending.expected,
        type: 'delivered',
        counter: pending.expected.counter + 1,
      })
    )
      throw Error('ACK_REFUSED');
    this.#current(channel, pending);
    this.#pending.delete(channel);
    return Object.freeze({ observed: true, attempt: pending.expected.attempt });
  }
  cancel(channel) {
    this.#pending.delete(channel);
  }
}
