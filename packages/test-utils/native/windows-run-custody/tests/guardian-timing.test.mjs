import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureWindowsPortDeadline,
  stopWindowsGuardianFromPort,
  windowsDuration,
  WINDOWS_STARTUP_LIMIT_MS,
  WINDOWS_STOP_LIMIT_MS,
} from '../../../src/run-custody/windows/guardian-timing.mjs';

function manualClock() {
  let mono = 10_000;
  let wall = 1_979_582_400_000;
  let wallReads = 0;
  const timers = new Map();
  return {
    get wallReads() {
      return wallReads;
    },
    wallTimestamp: () => wall,
    wallNow() {
      wallReads += 1;
      return wall;
    },
    monotonicNow: () => mono,
    setTimer(callback, delay) {
      const token = Symbol();
      timers.set(token, { at: mono + delay, callback });
      return token;
    },
    clearTimer(token) {
      timers.delete(token);
    },
    advance(elapsed, wallChange = elapsed) {
      mono += elapsed;
      wall += wallChange;
    },
    runTimers() {
      for (const [token, timer] of timers) {
        if (timer.at > mono) continue;
        timers.delete(token);
        timer.callback();
      }
    },
  };
}

test('port startup captures the wall clock once and refuses expired operation work', () => {
  const clock = manualClock();
  const budget = captureWindowsPortDeadline(
    clock.wallTimestamp() + 15_000,
    WINDOWS_STARTUP_LIMIT_MS,
    clock
  );
  assert.equal(budget.remainingMs(), 15_000);
  clock.advance(3000, 1_000_000);
  assert.equal(budget.remainingMs(), 12_000);
  clock.advance(12_000, -2_000_000);
  assert.equal(budget.remainingMs(), 0);
  assert.equal(clock.wallReads, 1);
  assert.equal(
    captureWindowsPortDeadline(
      clock.wallTimestamp() - 1,
      WINDOWS_STARTUP_LIMIT_MS,
      clock
    ).remainingMs(),
    0
  );
});

test('private local duration fires once at the monotonic deadline', () => {
  const clock = manualClock();
  const budget = windowsDuration(5000, WINDOWS_STOP_LIMIT_MS, clock);
  let expired = 0;
  budget.arm(() => expired++);
  clock.advance(4999, -50_000);
  clock.runTimers();
  assert.equal(expired, 0);
  clock.advance(1, 200_000);
  clock.runTimers();
  clock.runTimers();
  assert.equal(expired, 1);
  assert.equal(clock.wallReads, 0);
});

test('a delayed report cannot succeed even before a delayed expiration callback runs', async () => {
  const clock = manualClock();
  let onReport;
  const report = new Promise((resolve) => {
    onReport = resolve;
  });
  const expired = new Error('unconfirmed');
  const pending = windowsDuration(5000, WINDOWS_STOP_LIMIT_MS, clock).wait(report, expired);
  clock.advance(5000);
  onReport({ joined: true });
  await assert.rejects(pending, (error) => error === expired);
});

test('ordinary grace and native join share one 5s monotonic stop window', async () => {
  const clock = manualClock();
  const events = [];
  const pending = stopWindowsGuardianFromPort(
    {
      deadline: clock.wallTimestamp() + 30_000,
      waitForOrdinaryStop() {
        events.push('ordinary');
        return new Promise(() => {});
      },
      requestNativeStop(waitMs) {
        events.push(waitMs);
        clock.advance(1000, -40_000);
        return { joined: true, cleanupError: 0 };
      },
    },
    clock
  );
  clock.advance(3000, 800_000);
  clock.runTimers();
  const result = await pending;
  assert.equal(clock.wallReads, 1);
  assert.deepEqual(events, ['ordinary', 2000]);
  assert.equal(result.ordinary.kind, 'unconfirmed');
  assert.match(result.ordinary.error.message, /within grace/);
  assert.deepEqual(result.native, { kind: 'reported', result: { joined: true, cleanupError: 0 } });
});

test('an expired adapter still requests native cleanup and preserves uncertainty', async () => {
  const clock = manualClock();
  const events = [];
  const result = await stopWindowsGuardianFromPort(
    {
      deadline: clock.wallTimestamp() - 1,
      waitForOrdinaryStop() {
        assert.fail('ordinary grace cannot start after the shared deadline');
      },
      requestNativeStop(waitMs) {
        events.push(waitMs);
        return { joined: true };
      },
    },
    clock
  );
  assert.deepEqual(events, [0]);
  assert.equal(result.ordinary.kind, 'not-requested');
  assert.equal(result.native.kind, 'unconfirmed');
});

test('ordinary failure and native failure keep independent diagnostics', async () => {
  const clock = manualClock();
  const nativeError = new Error('observed native transport failure');
  const result = await stopWindowsGuardianFromPort(
    {
      deadline: clock.wallTimestamp() + 3_000,
      waitForOrdinaryStop() {
        throw undefined;
      },
      requestNativeStop(waitMs) {
        assert.equal(waitMs, 3000);
        throw nativeError;
      },
    },
    clock
  );
  assert.deepEqual(result, {
    ordinary: { kind: 'unconfirmed', error: undefined },
    native: { kind: 'unconfirmed', error: nativeError },
  });
});

test('an enclosing deadline shorter than grace cannot restart the native wait', async () => {
  const clock = manualClock();
  const requests = [];
  const pending = stopWindowsGuardianFromPort(
    {
      deadline: clock.wallTimestamp() + 700,
      waitForOrdinaryStop: () => new Promise(() => {}),
      requestNativeStop(waitMs) {
        requests.push(waitMs);
        return { joined: true };
      },
    },
    clock
  );
  clock.advance(700);
  clock.runTimers();
  const result = await pending;
  assert.deepEqual(requests, [0]);
  assert.equal(result.ordinary.kind, 'unconfirmed');
  assert.equal(result.native.kind, 'unconfirmed');
});
