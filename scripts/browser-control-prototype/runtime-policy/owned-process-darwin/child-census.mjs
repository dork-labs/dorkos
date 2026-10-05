import { performance } from 'node:perf_hooks';
import { closedRecord } from './framing.mjs';

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

const CAPACITY = 8;
const identityKeys = ['pid', 'uniqueId', 'generation', 'channel'];
function identity(value) {
  closedRecord(value, identityKeys);
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.uniqueId !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.uniqueId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !value.channel
  )
    throw Error('CENSUS_IDENTITY_UNKNOWN');
  return Object.freeze({ ...value });
}
function same(a, b) {
  return a && identityKeys.every((key) => a[key] === b[key]);
}
function arrayData(value, validate, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw Error(code);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !length ||
    !('value' in length) ||
    !Number.isInteger(length.value) ||
    length.value < 1 ||
    length.value >= CAPACITY ||
    Reflect.ownKeys(value).length !== length.value + 1
  )
    throw Error(code);
  const snapshot = [];
  for (let index = 0; index < length.value; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !('value' in entry)) throw Error(code);
    snapshot.push(validate(entry.value, code));
  }
  return Object.freeze(snapshot);
}
function pid(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw Error(code);
  return value;
}
function set(value) {
  closedRecord(value, ['count', 'errno', 'pids']);
  if (
    !Number.isInteger(value.count) ||
    value.count <= 0 ||
    value.count >= CAPACITY ||
    value.errno !== 0
  )
    throw Error('CENSUS_FILL_UNKNOWN');
  const pids = arrayData(value.pids, pid, 'CENSUS_FILL_UNKNOWN');
  if (pids.length !== value.count || new Set(pids).size !== pids.length)
    throw Error('CENSUS_FILL_UNKNOWN');
  return [...pids].sort((a, b) => a - b);
}

/** Compare independently returned data only; cleanup custody is deliberately not an input. */
export function compareChildCensus(first, second, manifest) {
  const a = set(first),
    b = set(second);
  if (a.length !== b.length || a.some((pid, index) => pid !== b[index]))
    throw Error('CENSUS_CHANGED');
  const snapshot = arrayData(manifest, pid, 'CENSUS_MANIFEST_UNKNOWN');
  if (new Set(snapshot).size !== snapshot.length) throw Error('CENSUS_MANIFEST_UNKNOWN');
  const expected = [...snapshot].sort((x, y) => x - y);
  if (a.some((pid) => !expected.includes(pid))) throw Error('EXTRA_UNREPORTED_CHILD');
  if (expected.some((pid) => !a.includes(pid))) throw Error('MISSING_REGISTERED_CHILD');
  return Object.freeze(a);
}

/** Injected owned-fixture barrier, not an installed-kernel or general descendant oracle. */
export async function observeChildCensus({ parent, children, ports, registerCleanup }) {
  const ownedParent = identity(parent);
  const ownedChildren = arrayData(children, identity, 'CENSUS_MANIFEST_UNKNOWN');
  if (
    !ownedChildren.length ||
    ownedChildren.length >= CAPACITY ||
    new Set(ownedChildren.map((child) => child.pid)).size !== ownedChildren.length
  )
    throw Error('CENSUS_MANIFEST_UNKNOWN');
  let cleanupCode;
  const challenges = new Set();
  const cookies = new Set();
  let stopped = false,
    samples = 0,
    registrations = 0;
  const stop = () => {
    stopped = true;
    try {
      ports.stopAdmission();
    } catch {
      cleanupCode = 'ADMISSION_CLOSE_UNKNOWN';
    }
  };
  // Registration precedes any fallible external observation, including observer callbacks.
  if (registerCleanup(stop) !== true) throw Error('CENSUS_CLEANUP_UNREGISTERED');
  const end = performance.now() + 2000;
  async function call(method, args = []) {
    if (stopped || performance.now() >= end) throw Error('CENSUS_DEADLINE');
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          const operation = ports[method];
          const current = performance.now();
          if (stopped || current >= end) throw Error('CENSUS_DEADLINE');
          return Reflect.apply(operation, ports, args);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('CENSUS_DEADLINE')),
            Math.max(0, end - performance.now())
          );
        }),
      ]);
      if (stopped || performance.now() >= end) throw Error('CENSUS_DEADLINE');
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function challenge(subject) {
    const nonce = await call('newChallenge');
    if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce))
      throw Error('CENSUS_CHALLENGE_UNKNOWN');
    if (challenges.has(nonce)) throw Error('CENSUS_CHALLENGE_REUSED');
    challenges.add(nonce);
    const response = await call('challenge', [subject, nonce]);
    closedRecord(response, ['identity', 'nonce', 'live', 'forkClosed', 'reapClosed', 'coverage']);
    if (
      !same(identity(response.identity), subject) ||
      response.nonce !== nonce ||
      response.live !== true ||
      response.forkClosed !== true ||
      response.reapClosed !== true ||
      response.coverage !== 'continuous'
    )
      throw Error('CENSUS_CUSTODY_UNKNOWN');
  }
  async function current(subject) {
    const value = await call('readIdentity', [subject]);
    if (!same(identity(value), subject)) throw Error('CENSUS_LIFETIME_CHANGED');
  }
  try {
    if ((await call('ownedQuiescentParent', [ownedParent, ownedChildren])) !== true)
      throw Error('CENSUS_QUIESCENCE_UNKNOWN');
    await current(ownedParent);
    for (const child of ownedChildren) {
      await current(child);
      await challenge(child);
    }
    const fills = [];
    for (let index = 0; index < 2; index++) {
      await current(ownedParent);
      await challenge(ownedParent);
      const fill = await call('fill', [ownedParent, CAPACITY]);
      samples++;
      const snapshot = set(fill);
      fills.push(
        Object.freeze({ count: snapshot.length, errno: 0, pids: Object.freeze(snapshot) })
      );
      await current(ownedParent);
      await challenge(ownedParent);
    }
    const pids = compareChildCensus(
      fills[0],
      fills[1],
      ownedChildren.map((child) => child.pid)
    );
    for (const child of ownedChildren) {
      await current(child);
      const receipt = await call('registerExit', [child]);
      registrations++;
      closedRecord(receipt, ['identity', 'registered', 'receiptError', 'cookie']);
      if (
        !same(identity(receipt.identity), child) ||
        receipt.registered !== true ||
        receipt.receiptError !== 0 ||
        typeof receipt.cookie !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.cookie)
      )
        throw Error('EXIT_REGISTRATION_UNKNOWN');
      if (cookies.has(receipt.cookie)) throw Error('EXIT_REGISTRATION_COOKIE_REUSED');
      cookies.add(receipt.cookie);
      await current(child);
      await challenge(child);
    }
    await current(ownedParent);
    await challenge(ownedParent);
    // Response reflection and the final clock observation can retire admission.
    const publicationTime = performance.now();
    if (stopped || publicationTime >= end) throw Error('CENSUS_DEADLINE');
    return Object.freeze({
      kind: 'injected-census',
      status: 'observed',
      pids,
      samples,
      registrations,
      nativeSamples: 0,
    });
  } catch (error) {
    stop();
    return Object.freeze({
      kind: 'injected-census',
      status: 'unverified',
      reason: errorCode(error, 'CENSUS_UNKNOWN'),
      samples,
      registrations,
      nativeSamples: 0,
      ...(cleanupCode ? { cleanupCode } : {}),
    });
  }
}
