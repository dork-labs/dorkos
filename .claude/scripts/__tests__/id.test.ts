/**
 * Tests for id.ts (spec #271 / DOR-184).
 *
 * Like spec-manifest-ops, id.ts is a standalone Node module run via
 * `node --experimental-strip-types`, not part of any workspace, so it is tested
 * with Node's built-in runner rather than Vitest. Run it directly:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/__tests__/id.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateId, allocateId, isTimestampId, isLegacyId, parseIdDate } from '../id.ts';

test('generateId formats the injected UTC clock as YYMMDD-HHMMSS', () => {
  // 2026-07-03T08:12:34Z — month is 0-indexed in Date.UTC, so 6 = July.
  const id = generateId(new Date(Date.UTC(2026, 6, 3, 8, 12, 34)));
  assert.equal(id, '260703-081234');
});

test('generateId zero-pads every field', () => {
  // 2026-01-05T03:04:09Z — all single-digit fields must pad to two digits.
  const id = generateId(new Date(Date.UTC(2026, 0, 5, 3, 4, 9)));
  assert.equal(id, '260105-030409');
});

test('generateId uses UTC, not local time', () => {
  // A fixed instant produces the same id regardless of the host timezone.
  const instant = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
  assert.equal(generateId(instant), '261231-235959');
});

test('isTimestampId accepts generated ids and rejects malformed ones', () => {
  assert.equal(isTimestampId(generateId(new Date(Date.UTC(2026, 6, 3, 8, 12, 34)))), true);
  assert.equal(isTimestampId('260703-081234'), true);
  assert.equal(isTimestampId('0294'), false); // legacy numeric
  assert.equal(isTimestampId('260703-08123'), false); // too short
  assert.equal(isTimestampId('260703081234'), false); // missing hyphen
  assert.equal(isTimestampId('26073-081234'), false); // wrong date width
});

test('isLegacyId accepts 4-digit numbers and rejects timestamp ids', () => {
  assert.equal(isLegacyId('0001'), true);
  assert.equal(isLegacyId('0294'), true);
  assert.equal(isLegacyId('0311'), true);
  assert.equal(isLegacyId('260703-081234'), false);
  assert.equal(isLegacyId('294'), false); // not zero-padded to 4
});

test('timestamp ids sort chronologically as plain strings', () => {
  const earlier = generateId(new Date(Date.UTC(2026, 6, 3, 8, 12, 34)));
  const later = generateId(new Date(Date.UTC(2026, 6, 3, 8, 12, 35))); // +1s
  assert.ok(earlier < later, 'a later instant must sort after an earlier one');

  const shuffled = ['260703-081235', '260101-000000', '260703-081234'];
  assert.deepEqual([...shuffled].sort(), ['260101-000000', '260703-081234', '260703-081235']);
});

test('legacy ids sort before timestamp ids under a plain string sort', () => {
  // The whole point of the freeze-and-coexist design: mixed listings stay ordered.
  const mixed = ['260703-081234', '0294', '0311', '260101-000000'];
  assert.deepEqual([...mixed].sort(), ['0294', '0311', '260101-000000', '260703-081234']);
});

test('parseIdDate round-trips a generated id at seconds precision', () => {
  const instant = new Date(Date.UTC(2026, 6, 3, 8, 12, 34));
  const parsed = parseIdDate(generateId(instant));
  assert.ok(parsed !== null);
  assert.equal(parsed.getTime(), instant.getTime());
});

test('parseIdDate returns null for non-timestamp ids', () => {
  assert.equal(parseIdDate('0294'), null);
  assert.equal(parseIdDate('not-an-id'), null);
});

test('allocateId returns the base id when it is free', () => {
  const at = new Date(Date.UTC(2026, 6, 3, 8, 12, 34));
  assert.equal(allocateId(() => false, at), '260703-081234');
});

test('allocateId bumps by whole seconds until it finds a free id', () => {
  const at = new Date(Date.UTC(2026, 6, 3, 8, 12, 34));
  const taken = new Set(['260703-081234', '260703-081235']);
  // 34 and 35 are taken -> lands on 36.
  assert.equal(allocateId((id) => taken.has(id), at), '260703-081236');
});
