/**
 * A circuit breaker for one bridge: after several outages or timeouts in a row,
 * stop calling it for a while and answer "unsure" at once, so a dead service
 * never slows a room down (research §5b).
 *
 * Only failures that say the SERVICE is unwell count: `outage` and `timeout`. A
 * refusal or an unknown label means the service answered, so it resets the run
 * like any other answer. A caller's own abort counts for nothing either way.
 *
 * @module decisions/circuit-breaker
 */
import type { DecisionModel, DecisionResult } from '@dorkos/shared/decision-model';
import { unsureResult } from './answers.js';

/** Settings for {@link withCircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Consecutive outages or timeouts that open the circuit. Default 3. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call. Default five minutes. */
  cooldownMs?: number;
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/** Five minutes: long enough to stop hammering a dead service, short enough to notice it is back. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

/** True when every answer failed because the service itself is unwell. */
function isServiceFailure(result: DecisionResult): boolean {
  const answers = Object.values(result.answers);
  return (
    answers.length > 0 && answers.every((a) => a.failure === 'outage' || a.failure === 'timeout')
  );
}

/** True when every answer stopped because the caller aborted. */
function isCallerAbort(result: DecisionResult): boolean {
  const answers = Object.values(result.answers);
  return answers.length > 0 && answers.every((a) => a.failure === 'aborted');
}

/**
 * Wrap a bridge in a circuit breaker. The wrapper has the same id and
 * capabilities; while the circuit is open it answers every question with
 * `circuit-open` without calling the bridge. After the cooldown one trial call
 * goes through: an answer closes the circuit, another failure re-opens it.
 *
 * @param model - The bridge to protect.
 * @param opts - See {@link CircuitBreakerOptions}.
 */
export function withCircuitBreaker(
  model: DecisionModel,
  opts: CircuitBreakerOptions = {}
): DecisionModel {
  const threshold = Math.max(1, opts.failureThreshold ?? 3);
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  let consecutive = 0;
  let openUntil = 0;

  return {
    id: model.id,
    capabilities: model.capabilities,
    async decide(req, signal) {
      if (consecutive >= threshold && now() < openUntil) {
        return unsureResult(req, model.id, 'circuit-open');
      }
      const result = await model.decide(req, signal);
      if (isCallerAbort(result)) return result;
      if (isServiceFailure(result)) {
        consecutive += 1;
        if (consecutive >= threshold) openUntil = now() + cooldownMs;
      } else {
        consecutive = 0;
      }
      return result;
    },
  };
}
