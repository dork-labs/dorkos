/**
 * Subscription management for the Relay message bus.
 *
 * Handles subscribe/unsubscribe operations and signal handler
 * registration, delegating to SubscriptionRegistry and SignalEmitter.
 *
 * @module relay/relay-subscriptions
 */
import type { Signal } from '@dorkos/shared/relay-schemas';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { SignalEmitter } from './signal-emitter.js';
import type { MessageHandler, SignalHandler, Unsubscribe } from './types.js';

/** Dependencies injected into the subscription module. */
export interface SubscriptionDeps {
  subscriptionRegistry: SubscriptionRegistry;
  signalEmitter: SignalEmitter;
}

/**
 * Subscribe to messages matching a pattern.
 *
 * The handler will be invoked for every new message that arrives
 * at any endpoint whose subject matches the given pattern. Pattern
 * matching uses NATS-style wildcards (`*` and `>`).
 *
 * @param pattern - A subject pattern, possibly with wildcards
 * @param handler - Callback invoked with matching envelopes
 * @param deps - Injected dependencies
 * @returns An Unsubscribe function to remove this subscription
 */
export function executeSubscribe(
  pattern: string,
  handler: MessageHandler,
  deps: SubscriptionDeps
): Unsubscribe {
  return deps.subscriptionRegistry.subscribe(pattern, handler);
}

/**
 * Emit an ephemeral signal (never touches disk).
 *
 * @param subject - A concrete subject for the signal
 * @param signalData - The signal payload
 * @param deps - Injected dependencies
 */
export function executeSignal(subject: string, signalData: Signal, deps: SubscriptionDeps): void {
  deps.signalEmitter.emit(subject, signalData);
}

/**
 * Subscribe to ephemeral signals matching a pattern.
 *
 * @param pattern - A subject pattern, possibly with wildcards
 * @param handler - Callback invoked for matching signals
 * @param deps - Injected dependencies
 * @returns An Unsubscribe function to remove this subscription
 */
export function executeOnSignal(
  pattern: string,
  handler: SignalHandler,
  deps: SubscriptionDeps
): Unsubscribe {
  return deps.signalEmitter.subscribe(pattern, handler);
}
