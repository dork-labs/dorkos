/**
 * Declarations only a reviewed list of capabilities may make. Each one lets a
 * call skip a protection every other capability keeps, so `composeRegistry`
 * refuses it on any id not named here, and a new one is a reviewed edit.
 *
 * @module services/core/capabilities/declarations/narrow-declarations
 */
import type { CapabilityDefinition, CapabilityWifiMode } from '../capability-definition.js';

/**
 * The only capabilities that may declare `cancelWindow`, the 60-second hold
 * that stands in for an approval card (spec `trusted-by-default-flip` §5.6).
 */
export const CANCEL_WINDOW_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'connectors.execute_destructive',
]);

/**
 * The only capabilities that may declare a network mode (`wifi`), each with
 * the one mode it may declare (ADR 261125-114705, decision 3). A network
 * sign-in otherwise acts at the computer (DOR-2969).
 *
 * - `lowers-power`: actions that only lower an agent's power, which a person
 *   on the network must be able to take.
 * - `person-held`: a person's own to-do writes, which the app makes from any
 *   device on purpose (DOR-5070); the mount holds them to the Wi-Fi hold.
 */
export const WIFI_MODE_CAPABILITY_IDS: ReadonlyMap<string, CapabilityWifiMode> = new Map([
  ['agent.pause', 'lowers-power'],
  ['todos.add_as_person', 'person-held'],
  ['todos.change_as_person', 'person-held'],
  ['todos.change_promise', 'person-held'],
  ['todos.confirm_promise', 'person-held'],
]);

/**
 * Refuse a core capability that makes a narrow declaration it is not listed for.
 *
 * @param capability - The capability being composed.
 * @throws When it declares `cancelWindow` or a `wifi` mode without being listed
 *   for it, or `person-held` on a capability any agent may call.
 */
export function assertNarrowDeclarations(
  capability: Pick<CapabilityDefinition, 'id' | 'cancelWindow' | 'wifi' | 'surfaces'>
): void {
  const { id } = capability;
  if (capability.cancelWindow && !CANCEL_WINDOW_CAPABILITY_IDS.has(id)) {
    throw new Error(`Capability registry: "${id}" may not declare a cancel window.`);
  }
  if (capability.wifi === undefined) return;
  if (WIFI_MODE_CAPABILITY_IDS.get(id) !== capability.wifi) {
    throw new Error(`Capability registry: "${id}" may not run from a sign-in on your network.`);
  }
  if (capability.wifi === 'person-held' && capability.surfaces.http?.audience !== 'person') {
    throw new Error(`Capability registry: "${id}" is person-held, so only a person may call it.`);
  }
}
