import { expect, it, vi } from 'vitest';
import {
  createMeasuredBrowserResourceAdmission,
  captureMeasuredBrowserResourceAdmission,
  isMeasuredResourceAdmissionRefusal,
  type BrowserResourceObservation,
  type MeasuredBrowserResourceAdmission,
} from '../admission/measured-resource.js';

// Synthetic controlled values exercise the boundary; none is a production limit.
function fixture() {
  const envelope = {
    executableSHA256: 'a'.repeat(64),
    profiles: 3,
    browsers: 2,
    tabsPerBrowser: 2,
    viewersPerBrowser: 2,
    captureMinimumIntervalMilliseconds: 100,
    maximumCPUPercent: 60,
    minimumAvailableMemoryBytes: 1000,
    maximumBrowserRSSBytes: 2000,
    maximumObservationAgeMilliseconds: 50,
  };
  const state = {
    now: 100,
    observation: {
      complete: true,
      observedAtMilliseconds: 100,
      cpuPercent: 20,
      availableMemoryBytes: 1500,
      browserRSSBytes: 1000,
    } as BrowserResourceObservation,
  };
  const observe = vi.fn(() => state.observation);
  const owner = createMeasuredBrowserResourceAdmission({ envelope, now: () => state.now, observe });
  return { envelope, state, observe, gate: captureMeasuredBrowserResourceAdmission(owner) };
}
function refused(body: () => void) {
  let reason: unknown;
  try {
    body();
  } catch (value) {
    reason = value;
  }
  expect(isMeasuredResourceAdmissionRefusal(reason)).toBe(true);
}
it('captures reviewed limits and refuses full counts before touching the pressure producer', () => {
  const f = fixture();
  f.envelope.browsers = 16;
  f.envelope.captureMinimumIntervalMilliseconds = 1;
  expect(f.gate.captureMinimumIntervalMilliseconds).toBe(100);
  f.gate.profiles(2);
  refused(() => f.gate.profiles(3));
  f.gate.browser(f.envelope.executableSHA256, 1);
  expect(f.observe).toHaveBeenCalledTimes(1);
  refused(() => f.gate.browser(f.envelope.executableSHA256, 2));
  refused(() => f.gate.browser('b'.repeat(64), 0));
  expect(f.observe).toHaveBeenCalledTimes(1);
});
it.each([
  { complete: false },
  { cpuPercent: 61 },
  { cpuPercent: NaN },
  { availableMemoryBytes: 999 },
  { browserRSSBytes: 2001 },
  { observedAtMilliseconds: 49 },
  { observedAtMilliseconds: 101 },
])('refuses the actual incomplete, stale or pressured sample %j', (change) => {
  const f = fixture();
  f.state.observation = { ...f.state.observation, ...change };
  refused(() => f.gate.browser(f.envelope.executableSHA256, 0));
  expect(f.observe).toHaveBeenCalledTimes(1);
});
it('performs a callback-free final count recheck after a reentrant sampler', () => {
  const f = fixture();
  let used = 0;
  f.observe.mockImplementation(() => {
    used = 2;
    return f.state.observation;
  });
  f.gate.browser(f.envelope.executableSHA256, used);
  refused(() => f.gate.browserCount(used));
  expect(f.observe).toHaveBeenCalledTimes(1);
});
it.each([false, undefined])('preserves an original falsy sampler failure: %s', (value) => {
  const f = fixture();
  f.observe.mockImplementation(() => {
    throw value;
  });
  let reason: { value: unknown } | undefined;
  try {
    f.gate.browser(f.envelope.executableSHA256, 0);
  } catch (failure) {
    reason = { value: failure };
  }
  expect(reason).toEqual({ value });
  expect(isMeasuredResourceAdmissionRefusal(reason!.value)).toBe(false);
});
it('refuses a forged participant without reading its getters', () => {
  const read = vi.fn(() => {
    throw new Error('FORGED_GETTER');
  });
  const fake = Object.create(null) as MeasuredBrowserResourceAdmission;
  Object.defineProperty(fake, 'kind', { get: read });
  refused(() => captureMeasuredBrowserResourceAdmission(fake));
  expect(read).not.toHaveBeenCalled();
});

it('captures tab and viewer ceilings once without turning later source mutation into capacity', () => {
  const f = fixture();
  f.envelope.tabsPerBrowser = 64;
  f.envelope.viewersPerBrowser = 16;
  expect(f.gate.tabsPerBrowser).toBe(2);
  expect(f.gate.viewersPerBrowser).toBe(2);
});
it.each([
  { tabsPerBrowser: 0 },
  { tabsPerBrowser: 65 },
  { tabsPerBrowser: 1.5 },
  { viewersPerBrowser: 0 },
  { viewersPerBrowser: 17 },
  { viewersPerBrowser: NaN },
])('refuses invalid reviewed structural ceilings %j', (change) => {
  const f = fixture();
  refused(() =>
    createMeasuredBrowserResourceAdmission({
      envelope: { ...f.envelope, ...change },
      now: () => f.state.now,
      observe: f.observe,
    })
  );
  expect(f.observe).not.toHaveBeenCalled();
});
