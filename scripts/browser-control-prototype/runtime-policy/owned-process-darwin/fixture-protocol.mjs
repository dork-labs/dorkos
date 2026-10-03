import { closedRecord } from './framing.mjs';

const WORD = /^[A-Za-z0-9-]{1,64}$/;
const HEX = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
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
function decimal(value, maximum, positive = false) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw Error('FIXTURE_DECIMAL');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum || (positive && result < 1))
    throw Error('FIXTURE_DECIMAL');
  return result;
}
function fields(line, count) {
  if (
    typeof line !== 'string' ||
    Buffer.byteLength(line) > 639 ||
    !line.endsWith('\n') ||
    line.includes('\0')
  )
    throw Error('FIXTURE_FRAME');
  const result = line.slice(0, -1).split('\t');
  if (
    result.length !== count ||
    result.some((value) => !value.length || value.includes('\n') || value.includes('\r'))
  )
    throw Error('FIXTURE_FRAME');
  return result;
}
function binding(parts) {
  if (
    !WORD.test(parts[1]) ||
    !['kernel', 'constructed'].includes(parts[2]) ||
    !WORD.test(parts[3]) ||
    !HEX.test(parts[6]) ||
    !HEX.test(parts[7])
  )
    throw Error('FIXTURE_BINDING');
  return {
    run: parts[1],
    cohort: parts[2],
    attempt: parts[3],
    generation: decimal(parts[4], Number.MAX_SAFE_INTEGER, true),
    pid: decimal(parts[5], 2_147_483_647, true),
    tokenDigest: parts[6],
    challenge: parts[7],
    counter: decimal(parts[8], 24),
  };
}

/** Parse fixture ACK data only; exclusive channel identity must come from the owning transport. */
export function parseFixtureAck(line) {
  const parts = fields(line, 9);
  const type = { ARMED: 'armed', DELIVERED: 'delivered', CANCELLED: 'cancelled' }[parts[0]];
  if (!type) throw Error('FIXTURE_ACK_TYPE');
  return Object.freeze({ ...binding(parts), type });
}

/** Serialize an exact locally minted arm binding; received bytes cannot choose a target. */
export function armFixture(message) {
  closedRecord(message, KEYS);
  if (message.type !== 'armed') throw Error('FIXTURE_ACK_TYPE');
  const line =
    [
      'ARM',
      message.run,
      message.cohort,
      message.attempt,
      message.generation,
      message.pid,
      message.tokenDigest,
      message.challenge,
      message.counter,
    ].join('\t') + '\n';
  const parsed = binding(fields(line, 9));
  for (const key of Object.keys(parsed))
    if (parsed[key] !== message[key]) throw Error('FIXTURE_BINDING');
  return line;
}

/** Preserve the self-query count field separately from errno; no failure is a token observation. */
export function parseFixtureToken(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 639 || !line.endsWith('\n'))
    throw Error('FIXTURE_FRAME');
  const parts = line.slice(0, -1).split('\t');
  if (parts.length !== 5 || parts[0] !== 'TOKEN') throw Error('FIXTURE_TOKEN');
  const status = decimal(parts[1], 2);
  const raw = decimal(parts[2], 2_147_483_647);
  const countOrError = decimal(parts[3], 2_147_483_647);
  if (status === 1 && (raw !== 0 || countOrError !== 0 || !HEX.test(parts[4])))
    throw Error('FIXTURE_TOKEN');
  if (status !== 1 && parts[4] !== '') throw Error('FIXTURE_TOKEN');
  return Object.freeze({
    status,
    raw,
    countOrError,
    tokenHex: status === 1 ? parts[4] : null,
    provenance: 'kernel-issued-self-query-transported-by-owned-fixture',
  });
}

/** Preserve the original acquisition expiry through readiness, arm and exec transitions. */
export function remainingFixtureMs(acquiredAt, now) {
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(now) || now < acquiredAt)
    throw Error('FIXTURE_CLOCK');
  return Math.max(0, 15_000 - (now - acquiredAt));
}
