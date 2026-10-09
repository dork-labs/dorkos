import { expect, it } from 'vitest';
import { createOriginalFrameRetirementReport } from './private-frame-retirement-report.fixture.js';

const parent = Object.freeze({ pid: 10, birth: 'original-parent' });
const cli = Object.freeze({ pid: 20, birth: 'original-cli' });
const frontend = Object.freeze({ pid: 30, birth: 'original-frontend' });
const native = Object.freeze({ pid: 40, birth: 'original-native' });
function snapshot(
  report: ReturnType<typeof createOriginalFrameRetirementReport>,
  primary?: { value: unknown }
) {
  return report.snapshot({
    knownBirths: [cli, frontend, native],
    excludedParent: parent,
    originalChildPids: { cli: cli.pid, frontend: frontend.pid },
    primary,
  });
}

it.each([false, undefined])(
  'retains primary %s independently of later cleanup and observation errors',
  (cause) => {
    const report = createOriginalFrameRetirementReport();
    report.failure('frontend-close', Error('PRIVATE_LATER_TEXT'));
    report.failure('cli-pipes', undefined);
    report.observed(cli, 'dead');
    report.observationFailure(frontend, false, false);
    report.observed(native, 'unknown');
    report.observationFailure(native, Error('UNVERIFIED'), true);
    const value = snapshot(report, { value: cause });
    expect(value.primary).toEqual({ causeKind: cause === false ? 'false' : 'undefined' });
    expect(value.cleanupFailures).toEqual([
      { stage: 'frontend-close', causeKind: 'object' },
      { stage: 'cli-pipes', causeKind: 'undefined' },
    ]);
    expect(value.observations).toEqual([
      { identity: cli, outcome: 'observed', status: 'dead' },
      { identity: frontend, outcome: 'threw', causeKind: 'false' },
      { identity: native, outcome: 'observed', status: 'unknown' },
      { identity: native, outcome: 'retirement-refused', causeKind: 'object' },
    ]);
    expect(value.knownBirths).toEqual([cli, frontend, native]);
    expect(value.excludedParent).toEqual(parent);
    expect(value.knownBirths).not.toContainEqual(parent);
    expect(JSON.stringify(value)).not.toContain('PRIVATE_LATER_TEXT');
  }
);

it('copies original identities and freezes each issued snapshot without reconstructing births', () => {
  const report = createOriginalFrameRetirementReport();
  const original = { pid: 50, birth: 'observer-original' };
  report.observed(original, 'dead');
  const earlier = report.snapshot({
    knownBirths: [original],
    excludedParent: parent,
    originalChildPids: { cli: null, frontend: null },
    primary: undefined,
  });
  original.birth = 'changed-after-retention';
  report.failure('cli-return', false);
  expect(earlier.observations[0]?.identity.birth).toBe('observer-original');
  expect(earlier.knownBirths[0]?.birth).toBe('observer-original');
  expect(earlier.cleanupFailures).toEqual([]);
  expect(Object.isFrozen(earlier.knownBirths[0])).toBe(true);
  expect(Object.isFrozen(earlier.observations)).toBe(true);
  expect(earlier.primary).toBeNull();
});

it('does not inspect producer error getters or invoke arbitrary diagnostic methods', () => {
  const opaque = new Proxy(
    {},
    {
      get() {
        throw Error('ERROR_PROPERTY_READ');
      },
    }
  );
  const report = createOriginalFrameRetirementReport();
  report.failure('projection-close', opaque);
  report.observationFailure(native, opaque, false);
  expect(() => JSON.stringify(snapshot(report, { value: opaque }))).not.toThrow();
  expect(snapshot(report).cleanupFailures).toEqual([
    { stage: 'projection-close', causeKind: 'object' },
  ]);
});
