/**
 * Per-endpoint circuit breaker for delivery protection.
 *
 * Implements the standard three-state machine pattern:
 * CLOSED -> OPEN -> HALF_OPEN -> CLOSED
 *
 * Each endpoint hash maintains independent state. When consecutive failures
 * exceed the threshold, the breaker trips OPEN, rejecting all deliveries
 * until the cooldown elapses. After cooldown, the breaker enters HALF_OPEN,
 * allowing probe messages to test recovery.
 *
 * @module relay/circuit-breaker
 */
import type { CircuitBreakerState, CircuitBreakerResult, CircuitBreakerConfig } from './types.js';

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenProbeCount: 1,
  successToClose: 2,
};

/**
 * Manages per-endpoint circuit breaker state.
 *
 * Each endpoint hash gets an independent breaker that tracks consecutive
 * failures and transitions through CLOSED, OPEN, and HALF_OPEN states.
 */
export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreakerState>();
  private config: CircuitBreakerConfig;

  /**
   * Create a new CircuitBreakerManager.
   *
   * @param config - Partial config overrides merged with defaults.
   */
  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CB_CONFIG, ...config };
  }

  /**
   * Check if delivery to an endpoint is allowed.
   *
   * @param endpointHash - The target endpoint's hash identifier.
   * @returns A result indicating whether delivery is allowed and current state.
   */
  check(endpointHash: string): CircuitBreakerResult {
    if (!this.config.enabled) {
      return { allowed: true, state: 'CLOSED' };
    }

    const breaker = this.getOrCreate(endpointHash);

    switch (breaker.state) {
      case 'CLOSED':
        return { allowed: true, state: 'CLOSED' };

      case 'OPEN': {
        const elapsed = Date.now() - (breaker.openedAt ?? 0);
        if (elapsed >= this.config.cooldownMs) {
          breaker.state = 'HALF_OPEN';
          breaker.halfOpenSuccesses = 0;
          return { allowed: true, state: 'HALF_OPEN' };
        }
        return {
          allowed: false,
          reason: `circuit open for endpoint ${endpointHash}`,
          state: 'OPEN',
        };
      }

      case 'HALF_OPEN':
        return { allowed: true, state: 'HALF_OPEN' };
    }
  }

  /**
   * Record a successful delivery to an endpoint.
   *
   * In CLOSED state, resets the consecutive failure count.
   * In HALF_OPEN state, increments success count and transitions
   * to CLOSED once successToClose threshold is met.
   *
   * @param endpointHash - The endpoint that succeeded.
   */
  recordSuccess(endpointHash: string): void {
    const breaker = this.breakers.get(endpointHash);
    if (!breaker) return;

    switch (breaker.state) {
      case 'CLOSED':
        breaker.consecutiveFailures = 0;
        break;

      case 'HALF_OPEN':
        breaker.halfOpenSuccesses++;
        if (breaker.halfOpenSuccesses >= this.config.successToClose) {
          breaker.state = 'CLOSED';
          breaker.consecutiveFailures = 0;
          breaker.openedAt = null;
          breaker.halfOpenSuccesses = 0;
        }
        break;
    }
  }

  /**
   * Record a failed delivery to an endpoint.
   *
   * In CLOSED state, increments failure count and trips to OPEN
   * when failureThreshold is reached. In HALF_OPEN state,
   * immediately transitions back to OPEN.
   *
   * @param endpointHash - The endpoint that failed.
   */
  recordFailure(endpointHash: string): void {
    const breaker = this.getOrCreate(endpointHash);

    breaker.consecutiveFailures++;

    switch (breaker.state) {
      case 'CLOSED':
        if (breaker.consecutiveFailures >= this.config.failureThreshold) {
          breaker.state = 'OPEN';
          breaker.openedAt = Date.now();
        }
        break;

      case 'HALF_OPEN':
        breaker.state = 'OPEN';
        breaker.openedAt = Date.now();
        breaker.halfOpenSuccesses = 0;
        break;
    }
  }

  /**
   * Get the current state of all circuit breakers.
   *
   * @returns A shallow copy of the breaker state map.
   */
  getStates(): Map<string, CircuitBreakerState> {
    return new Map(this.breakers);
  }

  /**
   * Reset a specific breaker to CLOSED by removing it.
   *
   * @param endpointHash - The endpoint to reset.
   */
  reset(endpointHash: string): void {
    this.breakers.delete(endpointHash);
  }

  /**
   * Update configuration for future checks (supports hot-reload).
   *
   * @param config - Partial config overrides merged with current config.
   */
  updateConfig(config: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private getOrCreate(endpointHash: string): CircuitBreakerState {
    let breaker = this.breakers.get(endpointHash);
    if (!breaker) {
      breaker = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: null,
        halfOpenSuccesses: 0,
      };
      this.breakers.set(endpointHash, breaker);
    }
    return breaker;
  }
}

export { DEFAULT_CB_CONFIG };
