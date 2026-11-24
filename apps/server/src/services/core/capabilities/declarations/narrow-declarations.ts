/**
 * Declarations only a reviewed list of capabilities may make. Each one lets a
 * call skip a protection every other capability keeps, so `composeRegistry`
 * refuses it on any id not named here, and a new one is a reviewed edit.
 *
 * @module services/core/capabilities/declarations/narrow-declarations
 */
import type { CapabilityDefinition } from '../capability-definition.js';

/**
 * The only capabilities that may declare `cancelWindow`, the 60-second hold
 * that stands in for an approval card (spec `trusted-by-default-flip` §5.6).
 */
export const CANCEL_WINDOW_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'connectors.execute_destructive',
]);

/**
 * The only capabilities that may declare `allowFromWifi`: actions that only
 * lower an agent's power, which a person on Wi-Fi must be able to take
 * (DOR-4978). A Wi-Fi sign-in otherwise acts at the computer (DOR-2969).
 */
export const WIFI_ALLOWED_CAPABILITY_IDS: ReadonlySet<string> = new Set(['agent.pause']);

/**
 * Refuse a core capability that makes a narrow declaration it is not listed for.
 *
 * @param capability - The capability being composed.
 * @throws When it declares `cancelWindow` or `allowFromWifi` without being listed.
 */
export function assertNarrowDeclarations(
  capability: Pick<CapabilityDefinition, 'id' | 'cancelWindow' | 'allowFromWifi'>
): void {
  const { id } = capability;
  if (capability.cancelWindow && !CANCEL_WINDOW_CAPABILITY_IDS.has(id)) {
    throw new Error(`Capability registry: "${id}" may not declare a cancel window.`);
  }
  if (capability.allowFromWifi && !WIFI_ALLOWED_CAPABILITY_IDS.has(id)) {
    throw new Error(`Capability registry: "${id}" may not run from a Wi-Fi sign-in.`);
  }
}
