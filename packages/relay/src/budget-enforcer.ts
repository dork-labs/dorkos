/**
 * Budget envelope enforcement for the Relay message bus.
 *
 * Pure functions with no side effects. Budgets can only shrink, never grow.
 * All enforcement checks run in a fixed order; the first failing check
 * short-circuits and returns a rejection result.
 *
 * @module relay/budget-enforcer
 */
import type { RelayEnvelope, RelayBudget } from '@dorkos/shared/relay-schemas';
import type { BudgetResult } from './types.js';

/** One hour in milliseconds — default TTL for new budgets. */
const DEFAULT_TTL_MS = 3_600_000;

/**
 * Default maximum hop count when none is specified.
 *
 * Exported because it is also the ceiling an adapter clamps a caller-declared
 * budget against — a request may lower its own hop limit, never raise it (see
 * the webhook adapter's `continuedBudget`).
 */
export const DEFAULT_MAX_HOPS = 5;

/** Default call budget when none is specified. */
const DEFAULT_CALL_BUDGET = 10;

/**
 * Enforce budget constraints on an incoming envelope before delivery.
 *
 * Checks are evaluated in order:
 * 1. Hop count vs. max hops
 * 2. Cycle detection via ancestor chain
 * 3. TTL expiry
 * 4. Call budget exhaustion
 *
 * On success, returns an updated budget with incremented hopCount,
 * appended ancestor, and decremented callBudgetRemaining.
 *
 * @param envelope - The relay envelope to validate.
 * @param currentEndpoint - The subject of the endpoint receiving this message.
 * @returns A BudgetResult indicating whether delivery is allowed, with an
 *          optional rejection reason and the updated budget on success.
 */
export function enforceBudget(envelope: RelayEnvelope, currentEndpoint: string): BudgetResult {
  const { budget } = envelope;

  if (budget.hopCount >= budget.maxHops) {
    return {
      allowed: false,
      reason: `max hops exceeded (${budget.hopCount}/${budget.maxHops})`,
    };
  }

  if (budget.ancestorChain.includes(currentEndpoint)) {
    return {
      allowed: false,
      reason: `cycle detected: ${currentEndpoint} already in chain`,
    };
  }

  if (Date.now() > budget.ttl) {
    return {
      allowed: false,
      reason: 'message expired (TTL)',
    };
  }

  if (budget.callBudgetRemaining <= 0) {
    return {
      allowed: false,
      reason: 'call budget exhausted',
    };
  }

  const updatedBudget: RelayBudget = {
    ...budget,
    hopCount: budget.hopCount + 1,
    ancestorChain: [...budget.ancestorChain, currentEndpoint],
    callBudgetRemaining: budget.callBudgetRemaining - 1,
  };

  return { allowed: true, updatedBudget };
}

/**
 * Create a default budget with sensible values, optionally overriding specific fields.
 *
 * Defaults:
 * - hopCount: 0 (no hops taken yet)
 * - maxHops: 5
 * - ancestorChain: [] (no ancestors)
 * - ttl: now + 1 hour
 * - callBudgetRemaining: 10
 *
 * @param overrides - Partial budget fields to override the defaults.
 * @returns A fully populated RelayBudget ready for use in a new envelope.
 */
export function createDefaultBudget(overrides?: Partial<RelayBudget>): RelayBudget {
  return {
    hopCount: 0,
    maxHops: DEFAULT_MAX_HOPS,
    ancestorChain: [],
    ttl: Date.now() + DEFAULT_TTL_MS,
    callBudgetRemaining: DEFAULT_CALL_BUDGET,
    ...overrides,
  };
}
