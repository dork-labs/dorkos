import { closedRecord } from './framing.mjs';

const COUNTS = [
  'fixtureSubjects',
  'identityQueries',
  'censusCalls',
  'exitRegistrations',
  'exitEvents',
  'signals',
  'deliveries',
  'refusals',
  'terminations',
];
const RESULT = ['type', 'cohort', 'status', 'reason', ...COUNTS, 'coverage', 'slotsClosed'];
const KEYS = {
  attempt: [
    'type',
    'cohort',
    'provenance',
    'ordinal',
    'raw',
    'status',
    'error',
    'delivery',
    'refusal',
    'tokenDigest',
  ],
  termination: [
    'type',
    'cohort',
    'ordinal',
    'raw',
    'status',
    'error',
    'chosenSignal',
    'waitStatus',
    'observed',
  ],
  result: RESULT,
};
const integer = (value) =>
  Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647;

/** Closed channel records are observations, never authority or an inferred inventory. */
export function guardianFrame(value, allocation) {
  if (!value || typeof value.type !== 'string' || !KEYS[value.type]) throw Error('GUARDIAN_FRAME');
  closedRecord(value, KEYS[value.type]);
  if (value.cohort !== allocation.id) throw Error('GUARDIAN_FRAME');
  if (value.type === 'result') {
    if (
      !['observed', 'unverified', 'failed'].includes(value.status) ||
      typeof value.reason !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.reason) ||
      !['continuous', 'lost', 'unknown'].includes(value.coverage) ||
      typeof value.slotsClosed !== 'boolean' ||
      COUNTS.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
      value.fixtureSubjects > allocation.acquisitions - 1 ||
      value.identityQueries > 128 ||
      value.censusCalls > 2 ||
      value.exitRegistrations > 1 ||
      value.exitEvents > value.exitRegistrations ||
      value.signals > allocation.signals ||
      value.deliveries + value.refusals + value.terminations > value.signals ||
      (value.status === 'observed' && value.coverage !== 'continuous')
    )
      throw Error('GUARDIAN_FRAME');
    if (
      value.reason === 'NATIVE_EXPORT_UNAVAILABLE' &&
      (value.status !== 'unverified' ||
        value.coverage !== 'unknown' ||
        COUNTS.some((key) => value[key] !== 0))
    )
      throw Error('GUARDIAN_FRAME');
  } else {
    if (
      !Number.isSafeInteger(value.ordinal) ||
      value.ordinal < 1 ||
      value.ordinal > allocation.signals ||
      !integer(value.raw) ||
      !integer(value.error) ||
      ![0, 1, 2].includes(value.status)
    )
      throw Error('GUARDIAN_FRAME');
    if (value.type === 'attempt') {
      if (
        !['constructed-private', 'kernel-self-query'].includes(value.provenance) ||
        typeof value.delivery !== 'boolean' ||
        typeof value.refusal !== 'boolean' ||
        (value.delivery && value.refusal) ||
        typeof value.tokenDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.tokenDigest) ||
        (value.delivery && (value.status !== 1 || value.raw !== 0)) ||
        (value.refusal && value.status !== 2)
      )
        throw Error('GUARDIAN_FRAME');
    } else if (
      !integer(value.chosenSignal) ||
      !integer(value.waitStatus) ||
      typeof value.observed !== 'boolean' ||
      (value.observed &&
        (value.status !== 1 || value.raw !== 0 || ![9, 15].includes(value.chosenSignal)))
    )
      throw Error('GUARDIAN_FRAME');
  }
  return Object.freeze({ ...value });
}
