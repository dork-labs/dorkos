/**
 * Calling a capability invocation observer, kept out of `registry.ts`: the
 * person read group reaches the observer here and never the handler (DOR-4978).
 *
 * @module services/core/capabilities/context/notify-observer
 */
import type {
  CapabilityHandlerContext,
  CapabilityInvocationContext,
  CapabilityInvocationObserver,
} from '../registry.js';
import type { CapabilityDefinition } from '../capability-definition.js';
import { personReadGroup } from './person-read.js';

/**
 * Call an invocation observer, swallowing anything it throws.
 *
 * Attribution is a side channel: it must never turn a successful capability
 * call into a failed one, nor mask the handler's own error with its own.
 *
 * @param observer - The observer to call.
 * @param capability - The capability that ran.
 * @param context - The context the handler was invoked with.
 * @param supplied - What the caller supplied, read only for the person read group.
 * @param ok - Whether the handler completed without throwing.
 * @param error - What the handler threw, when it did.
 */
export function notify(
  observer: CapabilityInvocationObserver,
  capability: CapabilityDefinition,
  context: CapabilityHandlerContext,
  supplied: CapabilityInvocationContext,
  ok: boolean,
  error?: unknown
): void {
  try {
    // The read group rides to the observer alone, never to the handler (DOR-4978).
    const readGroup = personReadGroup(supplied.person);
    observer({
      capability,
      context,
      ok,
      ...(ok ? {} : { error }),
      ...(readGroup && { readGroup }),
    });
  } catch {
    // Deliberately ignored — see the TSDoc above.
  }
}
