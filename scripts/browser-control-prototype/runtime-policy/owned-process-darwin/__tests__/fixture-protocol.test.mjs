import assert from 'node:assert/strict';
import test from 'node:test';
import {
  armFixture,
  parseFixtureAck,
  parseFixtureToken,
  remainingFixtureMs,
} from '../fixture-protocol.mjs';
const message = () => ({
  run: 'run-a',
  cohort: 'kernel',
  attempt: 'attempt-a',
  generation: 1,
  pid: 123,
  tokenDigest: 'a'.repeat(64),
  challenge: 'b'.repeat(64),
  counter: 0,
  type: 'armed',
});
test('canonical arm/ACK roundtrip preserves exact generation, PID and token digest', () => {
  const value = message();
  const line = armFixture(value);
  assert.deepEqual(parseFixtureAck(line.replace('ARM\t', 'ARMED\t')), value);
});
test('empty/collapsed, padded, signed, nonhex and oversized ACK fields refuse', () => {
  const line = armFixture(message()).replace('ARM\t', 'ARMED\t');
  for (const candidate of [
    line.replace('run-a\t', '\t'),
    line.replace('\t1\t', '\t01\t'),
    line.replace('\t123\t', '\t+123\t'),
    line.replace('a'.repeat(64), 'G'.repeat(64)),
    line.replace('\n', '\tEXTRA\n'),
    line.replace('run-a', 'x'.repeat(700)),
    line.replace('\n', '\r\n'),
  ])
    assert.throws(() => parseFixtureAck(candidate));
});
test('self-token success is distinct from failed count and never normalizes private count to errno', () => {
  assert.equal(parseFixtureToken('TOKEN\t1\t0\t0\t' + 'a'.repeat(64) + '\n').tokenHex.length, 64);
  const failed = parseFixtureToken('TOKEN\t0\t0\t7\t\n');
  assert.equal(failed.tokenHex, null);
  assert.equal(failed.countOrError, 7);
  assert.throws(() => parseFixtureToken('TOKEN\t1\t0\t7\t' + 'a'.repeat(64) + '\n'));
});
test('exec and arm cannot renew original fixture expiry', () => {
  const acquiredAt = 100;
  assert.equal(remainingFixtureMs(acquiredAt, 100), 15000);
  assert.equal(remainingFixtureMs(acquiredAt, 7100), 8000);
  assert.equal(remainingFixtureMs(acquiredAt, 15100), 0);
  assert.throws(() => remainingFixtureMs(acquiredAt, 99), /FIXTURE_CLOCK/);
});
