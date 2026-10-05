import assert from 'node:assert/strict';
import test from 'node:test';
import { CohortBudget, COHORTS } from '../cohort-budget.mjs';

test('six isolated cohorts share one actual ledger without renewing acquisition or cleanup caps', () => {
  let now = 0;
  const budget = new CohortBudget(() => now);
  for (const cohort of COHORTS) {
    const allocation = budget.open(cohort);
    for (let i = 0; i < cohort.acquisitions; i++) budget.acquire(allocation);
    for (let i = 0; i < cohort.signals; i++) budget.signal(allocation);
    budget.closeAdmission(allocation);
    assert.throws(() => budget.acquire(allocation), /COHORT_ADMISSION_CLOSED/);
    for (let i = 0; i < cohort.acquisitions; i++) budget.gone(allocation);
    budget.finish(allocation, true);
    now += cohort.phaseMs;
  }
  assert.equal(budget.acquisitions, 22);
  assert.equal(budget.signals, 16);
  assert.equal(budget.live, 1);
  const end = budget.faultCleanupEnd();
  now++;
  assert.equal(budget.faultCleanupEnd(), end);
  for (let i = 0; i < 8; i++) budget.cleanupSignal();
  assert.equal(budget.signals, 24);
  assert.throws(() => budget.cleanupSignal(), /CLEANUP_SIGNAL_CAP/);
});
test('coverage loss forbids any queued or late acquisition in that cohort', () => {
  const budget = new CohortBudget(() => 0);
  const allocation = budget.open(COHORTS[0]);
  budget.acquire(allocation);
  budget.closeAdmission(allocation);
  assert.throws(() => budget.acquire(allocation), /COHORT_ADMISSION_CLOSED/);
  assert.throws(() => budget.signal(allocation), /COHORT_ADMISSION_CLOSED/);
  assert.throws(() => budget.open(COHORTS[1]), /COHORT_ADMISSION_CLOSED/);
  assert.throws(() => budget.finish(allocation, false), /CUSTODY_UNKNOWN/);
  assert.throws(() => budget.open(COHORTS[1]), /COHORT_ADMISSION_CLOSED/);
});
test('reaped guardian alone cannot release remaining child ledger or start a fresh guardian', () => {
  const budget = new CohortBudget(() => 0);
  const allocation = budget.open(COHORTS[0]);
  budget.acquire(allocation);
  budget.acquire(allocation);
  budget.gone(allocation);
  assert.throws(() => budget.finish(allocation, true), /CUSTODY_UNKNOWN/);
  assert.equal(budget.live, 2);
  assert.throws(() => budget.open(COHORTS[1]), /COHORT_ADMISSION_CLOSED/);
});
test('absolute phase/run and one fault deadline never renew on new guardians', () => {
  let now = 0;
  const budget = new CohortBudget(() => now);
  const allocation = budget.open(COHORTS[0]);
  now = allocation.end;
  assert.throws(() => budget.acquire(allocation), /COHORT_ADMISSION_CLOSED/);
  const end = budget.faultCleanupEnd();
  now = end;
  assert.throws(() => budget.cleanupSignal(), /CLEANUP_SIGNAL_CAP/);
  assert.equal(budget.faultCleanupEnd(), end);
});

for (const mode of ['nonfinite', 'rollback', 'throw']) {
  test(`failed ${mode} clock retains one cleanup label and grants no new rights`, () => {
    let fault = false;
    const budget = new CohortBudget(() => {
      if (fault && mode === 'throw') throw Error('secret-clock');
      return fault ? (mode === 'rollback' ? 9 : NaN) : 10;
    });
    const allocation = budget.open(COHORTS[0]);
    budget.acquire(allocation);
    fault = true;
    const end = budget.faultCleanupEnd();
    assert.equal(end, 20010);
    assert.equal(budget.faultCleanupEnd(), end);
    assert.equal(budget.clockUnverified, true);
    assert.equal(budget.stopped, true);
    assert.throws(() => budget.acquire(allocation), /COHORT_ADMISSION_CLOSED/);
    assert.throws(() => budget.cleanupSignal(), /CLOCK_UNVERIFIED/);
    assert.equal(budget.acquisitions, 2);
    assert.equal(budget.signals, 0);
  });
}

for (const mode of ['stable', 'nonfinite', 'rollback', 'throw']) {
  test(`recovered ${mode} clock cannot reopen irreversibly refused cleanup signals`, () => {
    // Stable time retains its cleanup reserve; prior uncertainty never regains that permission.
    let value = 100,
      broken = false;
    const budget = new CohortBudget(() => {
      if (broken && mode === 'throw') throw Error('PRIVATE_CLOCK');
      return value;
    });
    const allocation = budget.open(COHORTS[0]);
    budget.acquire(allocation);
    if (mode !== 'stable') {
      value = mode === 'rollback' ? 99 : NaN;
      broken = true;
      assert.throws(() => budget.time(), /CLOCK_UNVERIFIED/);
    }
    const end = budget.faultCleanupEnd();
    value = 101;
    broken = false;
    if (mode === 'stable') {
      budget.cleanupSignal();
      assert.equal(budget.signals, 1);
    } else {
      assert.throws(
        () => budget.cleanupSignal(),
        /CLOCK_UNVERIFIED/,
        'FAILED_CLOCK_SIGNAL_AUTHORITY_REOPENED'
      );
      assert.equal(budget.signals, 0);
      assert.equal(budget.cleanupSignals, 0);
      assert.equal(budget.clockUnverified, true);
    }
    assert.equal(budget.faultCleanupEnd(), end);
    assert.throws(() => budget.acquire(allocation), /COHORT_ADMISSION_CLOSED/);
    assert.throws(() => budget.signal(allocation), /COHORT_ADMISSION_CLOSED/);
    assert.equal(budget.acquisitions, 2);
  });
}

test('clock callback reentry cannot grant a signal after recording then restoring uncertainty', () => {
  // Validate permission after trusted observation callbacks, not only at call entry.
  let value = 100,
    reenter = false;
  const budget = new CohortBudget(() => {
    if (reenter) {
      reenter = false;
      value = NaN;
      assert.throws(() => budget.time(), /CLOCK_UNVERIFIED/);
      value = 101;
    }
    return value;
  });
  budget.faultCleanupEnd();
  reenter = true;
  assert.throws(
    () => budget.cleanupSignal(),
    /CLOCK_UNVERIFIED/,
    'REENTRANT_CLOCK_SIGNAL_AUTHORITY_REOPENED'
  );
  assert.equal(budget.clockUnverified, true);
  assert.equal(budget.signals, 0);
});

test('first cleanup deadline observation cannot reopen signal permission through reentry', () => {
  // The deadline's first clock read is another external boundary before permission.
  let value = 100,
    reads = 0;
  const budget = new CohortBudget(() => {
    reads++;
    if (reads === 3) {
      value = NaN;
      assert.throws(() => budget.time(), /CLOCK_UNVERIFIED/);
      value = 101;
    }
    return value;
  });
  assert.throws(
    () => budget.cleanupSignal(),
    /CLOCK_UNVERIFIED/,
    'DEADLINE_CLOCK_SIGNAL_AUTHORITY_REOPENED'
  );
  assert.equal(budget.clockUnverified, true);
  assert.equal(budget.signals, 0);
});

for (const operation of ['acquire', 'signal']) {
  for (const transition of ['stable', 'nonfinite', 'stop', 'admission', 'replacement']) {
    test(`ordinary ${operation} revalidates ${transition} after its clock callback`, () => {
      let value = 100,
        action = null,
        nextAllocation;
      const budget = new CohortBudget(() => {
        const current = action;
        action = null;
        current?.();
        return value;
      });
      const allocation = budget.open(COHORTS[0]);
      const before = {
        acquisitions: budget.acquisitions,
        live: budget.live,
        signals: budget.signals,
      };
      action = () => {
        value = 101;
        if (transition === 'nonfinite') {
          value = NaN;
          assert.throws(() => budget.time(), /CLOCK_UNVERIFIED/);
          value = 101;
        } else if (transition === 'stop') budget.stop();
        else if (transition === 'admission') budget.closeAdmission(allocation);
        else if (transition === 'replacement') {
          budget.finish(allocation, true);
          nextAllocation = budget.open(COHORTS[1]);
        }
      };
      if (transition === 'stable') {
        budget[operation](allocation);
        assert.equal(budget.acquisitions, before.acquisitions + (operation === 'acquire' ? 1 : 0));
        assert.equal(budget.live, before.live + (operation === 'acquire' ? 1 : 0));
        assert.equal(budget.signals, before.signals + (operation === 'signal' ? 1 : 0));
      } else {
        assert.throws(
          () => budget[operation](allocation),
          /COHORT_ADMISSION_CLOSED/,
          `POST_CLOCK_${transition}_${operation}`
        );
        assert.deepEqual(
          { acquisitions: budget.acquisitions, live: budget.live, signals: budget.signals },
          before
        );
        if (transition === 'nonfinite') assert.equal(budget.clockUnverified, true);
        if (transition === 'replacement') {
          // The old operation must not consume a fresh cohort's allocation or counters.
          budget.acquire(nextAllocation);
          assert.equal(budget.acquisitions, before.acquisitions + 1);
          assert.equal(budget.live, before.live + 1);
        }
      }
    });
  }
}

test('admission inspection preserves charged counters and the original allocation end', () => {
  let now = 0;
  const budget = new CohortBudget(() => now);
  const allocation = budget.open(COHORTS[0]);
  budget.acquire(allocation);
  budget.signal(allocation);
  const before = [budget.acquisitions, budget.signals, budget.live, allocation.end];
  for (let i = 0; i < 8; i++) {
    now++;
    assert.equal(budget.assertAdmission(allocation), undefined);
    assert.deepEqual([budget.acquisitions, budget.signals, budget.live, allocation.end], before);
  }
});

for (const mode of [
  'closed',
  'finished',
  'clock-close',
  'clock-finish',
  'clock-stop',
  'clock-unknown',
])
  test('admission inspection refuses original allocation ' + mode, () => {
    let armed = false,
      allocation;
    const budget = new CohortBudget(() => {
      if (armed) {
        armed = false;
        if (mode === 'clock-close') budget.closeAdmission(allocation);
        if (mode === 'clock-finish') budget.finish(allocation, true);
        if (mode === 'clock-stop') budget.stop();
        if (mode === 'clock-unknown') return NaN;
      }
      return 0;
    });
    allocation = budget.open(COHORTS[0]);
    if (mode === 'closed') budget.closeAdmission(allocation);
    if (mode === 'finished') budget.finish(allocation, true);
    armed = true;
    const before = [budget.acquisitions, budget.signals, budget.live, allocation.end];
    assert.throws(
      () => budget.assertAdmission(allocation),
      /COHORT_ADMISSION_CLOSED|CLOCK_UNVERIFIED/
    );
    assert.deepEqual([budget.acquisitions, budget.signals, budget.live, allocation.end], before);
  });
