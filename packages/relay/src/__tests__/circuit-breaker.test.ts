import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreakerManager, DEFAULT_CB_CONFIG } from '../circuit-breaker.js';

describe('CircuitBreakerManager', () => {
  let cbm: CircuitBreakerManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T12:00:00.000Z'));
    cbm = new CircuitBreakerManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('CLOSED state', () => {
    it('allows delivery when no failures recorded', () => {
      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('CLOSED');
    });

    it('transitions to OPEN after failureThreshold consecutive failures', () => {
      for (let i = 0; i < DEFAULT_CB_CONFIG.failureThreshold; i++) {
        cbm.recordFailure('endpoint-abc');
      }

      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(false);
      expect(result.state).toBe('OPEN');
    });

    it('resets failure count on success', () => {
      cbm.recordFailure('endpoint-abc');
      cbm.recordFailure('endpoint-abc');
      cbm.recordFailure('endpoint-abc');

      const statesBefore = cbm.getStates();
      expect(statesBefore.get('endpoint-abc')?.consecutiveFailures).toBe(3);

      cbm.recordSuccess('endpoint-abc');

      const statesAfter = cbm.getStates();
      expect(statesAfter.get('endpoint-abc')?.consecutiveFailures).toBe(0);
    });
  });

  describe('OPEN state', () => {
    beforeEach(() => {
      // Trip the breaker to OPEN
      for (let i = 0; i < DEFAULT_CB_CONFIG.failureThreshold; i++) {
        cbm.recordFailure('endpoint-abc');
      }
    });

    it('rejects delivery immediately', () => {
      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(false);
      expect(result.state).toBe('OPEN');
    });

    it('transitions to HALF_OPEN after cooldown elapses', () => {
      // Advance time past the cooldown
      vi.setSystemTime(Date.now() + DEFAULT_CB_CONFIG.cooldownMs);

      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('HALF_OPEN');
    });
  });

  describe('HALF_OPEN state', () => {
    beforeEach(() => {
      // Trip to OPEN, then advance past cooldown to HALF_OPEN
      for (let i = 0; i < DEFAULT_CB_CONFIG.failureThreshold; i++) {
        cbm.recordFailure('endpoint-abc');
      }
      vi.setSystemTime(Date.now() + DEFAULT_CB_CONFIG.cooldownMs);
      cbm.check('endpoint-abc'); // triggers transition to HALF_OPEN
    });

    it('allows a single probe message', () => {
      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('HALF_OPEN');
    });

    it('transitions to CLOSED after successToClose consecutive successes', () => {
      for (let i = 0; i < DEFAULT_CB_CONFIG.successToClose; i++) {
        cbm.recordSuccess('endpoint-abc');
      }

      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('CLOSED');

      const states = cbm.getStates();
      const breaker = states.get('endpoint-abc');
      expect(breaker?.consecutiveFailures).toBe(0);
      expect(breaker?.openedAt).toBeNull();
      expect(breaker?.halfOpenSuccesses).toBe(0);
    });

    it('transitions back to OPEN on probe failure', () => {
      cbm.recordFailure('endpoint-abc');

      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(false);
      expect(result.state).toBe('OPEN');
    });
  });

  describe('state management', () => {
    it('maintains separate state per endpoint hash', () => {
      // Trip endpoint-a to OPEN
      for (let i = 0; i < DEFAULT_CB_CONFIG.failureThreshold; i++) {
        cbm.recordFailure('endpoint-a');
      }

      // endpoint-b should still be CLOSED
      const resultA = cbm.check('endpoint-a');
      const resultB = cbm.check('endpoint-b');

      expect(resultA.allowed).toBe(false);
      expect(resultA.state).toBe('OPEN');
      expect(resultB.allowed).toBe(true);
      expect(resultB.state).toBe('CLOSED');
    });

    it('reset() clears a specific breaker', () => {
      cbm.recordFailure('endpoint-abc');
      cbm.recordFailure('endpoint-abc');

      const statesBefore = cbm.getStates();
      expect(statesBefore.has('endpoint-abc')).toBe(true);

      cbm.reset('endpoint-abc');

      const statesAfter = cbm.getStates();
      expect(statesAfter.has('endpoint-abc')).toBe(false);

      // Next check creates a fresh CLOSED breaker
      const result = cbm.check('endpoint-abc');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('CLOSED');
    });
  });

  describe('disabled', () => {
    it('always allows when enabled=false', () => {
      const disabledCbm = new CircuitBreakerManager({ enabled: false });

      // Record many failures
      for (let i = 0; i < 100; i++) {
        disabledCbm.recordFailure('endpoint-abc');
      }

      const result = disabledCbm.check('endpoint-abc');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('CLOSED');
    });
  });
});
