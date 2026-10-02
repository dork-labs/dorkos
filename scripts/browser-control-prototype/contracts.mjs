import { isAbsolute } from 'node:path';

/** Bounds shared by independently owned prototype modules. */
export const LIMITS = Object.freeze({
  maxEvidenceBytes: 64 * 1024,
  maxFrameBytes: 2 * 1024 * 1024,
  maxPendingFrames: 1,
  maxActionBytes: 16 * 1024,
  maxBarrierMs: 2_000,
  maxSubjects: 128,
  maxMeasurements: 64,
  maxTextLength: 2_048,
});

const statuses = ['pass', 'fail', 'unverified'];
const outcomes = ['completed', 'rejected', 'failed', 'aborted', 'in-flight'];
const sensitive =
  /(?:bearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\bsk-(?:proj|ant)-[\w-]+|(?:cookie|password|secret|token|authorization|api[_-]?key)\s*[:=]\s*\S+|https?:\/\/[^\s/]*@|https?:\/\/\S*\?\S+)/i;

function check(condition, field) {
  if (!condition) throw new TypeError(`Invalid evidence field: ${field}`);
}

function object(value, keys, field) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  check(Object.getPrototypeOf(value) === Object.prototype, field);
  const actual = Object.keys(value);
  check(actual.length === keys.length && actual.every((key) => keys.includes(key)), field);
  check(
    Object.values(Object.getOwnPropertyDescriptors(value)).every((d) => 'value' in d),
    field
  );
}

function text(value, field, max = LIMITS.maxTextLength) {
  check(typeof value === 'string' && value.length > 0 && value.length <= max, field);
  // eslint-disable-next-line no-control-regex -- Receipts must reject C0 and DEL characters.
  check(!/[\u0000-\u001f\u007f]/.test(value) && !sensitive.test(value), field);
}

function id(value, field) {
  check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value), field);
  check(!sensitive.test(value), field);
}

function number(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isFinite(value) && value >= min && value <= max, field);
}

function integer(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  number(value, field, min, max);
  check(Number.isSafeInteger(value), field);
}

function array(value, field, max, validate) {
  check(Array.isArray(value) && value.length <= max, field);
  check(Object.getPrototypeOf(value) === Array.prototype, field);
  check(Reflect.ownKeys(value).length === value.length + 1, field);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor !== undefined && 'value' in descriptor, field);
    validate(descriptor.value, field);
  }
}

function enumValue(value, field, values) {
  check(values.includes(value), field);
}

/** Validate the local executable receipt; its absolute path is never public. */
export function validateRuntimeReceipt(value) {
  object(
    value,
    ['kind', 'libraryVersion', 'chromiumRevision', 'executablePath', 'executableSha256', 'os'],
    'runtime'
  );
  check(value.kind === 'runtime', 'kind');
  check(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.libraryVersion), 'libraryVersion');
  check(/^\d+$/.test(value.chromiumRevision), 'chromiumRevision');
  text(value.executablePath, 'executablePath');
  check(isAbsolute(value.executablePath), 'executablePath');
  check(/^[a-f0-9]{64}$/.test(value.executableSha256), 'executableSha256');
  object(value.os, ['platform', 'release', 'arch'], 'os');
  for (const [key, entry] of Object.entries(value.os)) text(entry, key, 128);
  return value;
}

function tabIdentity(value) {
  id(value.tabId, 'tabId');
  integer(value.navigationGeneration, 'navigationGeneration');
  integer(value.viewportVersion, 'viewportVersion', 1);
  integer(value.epoch, 'epoch');
}

/** Validate an outcome without storing action payloads or page contents. */
export function validateActionReceipt(value) {
  object(
    value,
    [
      'kind',
      'requestId',
      'tabId',
      'navigationGeneration',
      'viewportVersion',
      'actorId',
      'epoch',
      'outcome',
    ],
    'action'
  );
  check(value.kind === 'action', 'kind');
  id(value.requestId, 'requestId');
  id(value.actorId, 'actorId');
  tabIdentity(value);
  enumValue(value.outcome, 'outcome', outcomes);
  return value;
}

/** Validate capture identity and enforce the per-viewer frame size ceiling. */
export function validateFrameReceipt(value) {
  object(
    value,
    [
      'kind',
      'browserId',
      'tabId',
      'navigationGeneration',
      'viewportVersion',
      'epoch',
      'captureSequence',
      'width',
      'height',
      'byteLength',
    ],
    'frame'
  );
  check(value.kind === 'frame', 'kind');
  id(value.browserId, 'browserId');
  tabIdentity(value);
  integer(value.captureSequence, 'captureSequence', 1);
  integer(value.width, 'width', 1, 16_384);
  integer(value.height, 'height', 1, 16_384);
  integer(value.byteLength, 'byteLength', 1, LIMITS.maxFrameBytes);
  return value;
}

function observation(value, field) {
  object(value, ['status', 'sampleCount'], field);
  enumValue(value.status, 'status', statuses);
  integer(value.sampleCount, 'sampleCount', value.status === 'unverified' ? 0 : 1);
}

function negativeControl(value, field) {
  object(value, ['id', 'outcome', 'sampleCount'], field);
  id(value.id, 'control.id');
  enumValue(value.outcome, 'control.outcome', ['detected', 'missed', 'unverified']);
  integer(value.sampleCount, 'control.sampleCount', value.outcome === 'unverified' ? 0 : 1);
}

function measurement(value, field) {
  object(value, ['name', 'unit', 'sampleCount', 'min', 'max', 'p50', 'p95'], field);
  id(value.name, 'measurement.name');
  enumValue(value.unit, 'measurement.unit', ['ms', 'bytes', 'bytes/s', 'MiB', 'percent', 'count']);
  integer(value.sampleCount, 'measurement.sampleCount', 1);
  for (const key of ['min', 'max', 'p50', 'p95']) number(value[key], `measurement.${key}`);
  check(
    value.min <= value.p50 && value.p50 <= value.p95 && value.p95 <= value.max,
    'measurement.order'
  );
}

function artifact(value, field) {
  text(value, field, 256);
  check(!isAbsolute(value) && !value.includes('\\'), field);
  check(
    value
      .split('/')
      .every((segment) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(segment) && segment !== '..'),
    field
  );
  check(!/(?:^|\/)(?:profiles?|storage-state|cookies?)(?:[./-]|$)/i.test(value), field);
}

/** A passing gate requires observations, a green baseline and detected negative controls. */
export function validateGateReceipt(value) {
  object(
    value,
    [
      'kind',
      'gateId',
      'status',
      'subjectIds',
      'sampleCount',
      'baseline',
      'negativeControls',
      'command',
      'timings',
      'artifacts',
      'limitations',
      'measurements',
      'runtime',
    ],
    'gate'
  );
  check(value.kind === 'gate', 'kind');
  id(value.gateId, 'gateId');
  enumValue(value.status, 'status', statuses);
  array(value.subjectIds, 'subjectIds', LIMITS.maxSubjects, id);
  check(
    value.subjectIds.length > 0 && new Set(value.subjectIds).size === value.subjectIds.length,
    'subjectIds'
  );
  integer(value.sampleCount, 'sampleCount', value.status === 'unverified' ? 0 : 1);
  observation(value.baseline, 'baseline');
  array(value.negativeControls, 'negativeControls', LIMITS.maxSubjects, negativeControl);
  check(
    new Set(value.negativeControls.map((control) => control.id)).size ===
      value.negativeControls.length,
    'negativeControls'
  );
  if (value.status === 'pass') {
    check(value.baseline.status === 'pass', 'baseline.status');
    check(
      value.negativeControls.length > 0 &&
        value.negativeControls.every((control) => control.outcome === 'detected'),
      'negativeControls'
    );
  }
  text(value.command, 'command');
  object(value.timings, ['startedAt', 'durationMs'], 'timings');
  check(
    typeof value.timings.startedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.timings.startedAt) &&
      Number.isFinite(Date.parse(value.timings.startedAt)),
    'startedAt'
  );
  number(value.timings.durationMs, 'durationMs');
  array(value.artifacts, 'artifacts', LIMITS.maxSubjects, artifact);
  array(value.limitations, 'limitations', LIMITS.maxSubjects, text);
  if (value.status === 'unverified') check(value.limitations.length > 0, 'limitations');
  array(value.measurements, 'measurements', LIMITS.maxMeasurements, measurement);
  if (value.runtime === null) check(value.status === 'unverified', 'runtime');
  else validateRuntimeReceipt(value.runtime);
  return value;
}

/** Serialize only approved receipts; redact host paths for public reports by default. */
export function serializeEvidence(value, { publicReport = true } = {}) {
  const validators = {
    runtime: validateRuntimeReceipt,
    action: validateActionReceipt,
    frame: validateFrameReceipt,
    gate: validateGateReceipt,
  };
  check(
    value !== null && typeof value === 'object' && Object.hasOwn(validators, value.kind),
    'kind'
  );
  validators[value.kind](value);
  const copy = structuredClone(value);
  const runtime = copy.kind === 'runtime' ? copy : copy.runtime;
  if (publicReport && runtime) runtime.executablePath = '[local-only]';
  const result = JSON.stringify(copy, null, 2) + '\n';
  check(Buffer.byteLength(result) <= LIMITS.maxEvidenceBytes, 'serializedBytes');
  return result;
}
