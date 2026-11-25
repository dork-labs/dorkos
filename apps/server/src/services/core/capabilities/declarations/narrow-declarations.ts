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
 *   device on purpose (DOR-5070); the mount holds them to the Wi-Fi hold. And
 *   the owner's answer to the credits offer, which a phone could always give:
 *   Not now runs; Use credits is confirm-first, and the front-door bar refuses
 *   it from Wi-Fi before anything is held.
 */
export const WIFI_MODE_CAPABILITY_IDS: ReadonlyMap<string, CapabilityWifiMode> = new Map([
  ['agent.pause', 'lowers-power'],
  ['todos.add_as_person', 'person-held'],
  ['todos.change_as_person', 'person-held'],
  ['todos.change_promise', 'person-held'],
  ['todos.confirm_promise', 'person-held'],
  ['heartbeat.choose_triage_credits', 'person-held'],
]);

/**
 * The only capabilities that may declare a confirm-first hold (`confirmFirst`,
 * ADR 261125-114705, decision 4), each a person's account write the person
 * confirms on the "Confirm it's you" sheet.
 *
 * - `heartbeat.choose_triage_credits`: using DorkOS credits for heartbeat checks.
 */
export const CONFIRM_FIRST_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'heartbeat.choose_triage_credits',
]);

/**
 * Refuse a core capability that makes a narrow declaration it is not listed for.
 *
 * @param capability - The capability being composed.
 * @throws When it declares `cancelWindow`, a `wifi` mode or `confirmFirst`
 *   without being listed for it, or `person-held` or `confirmFirst` on a
 *   capability any agent may call.
 */
export function assertNarrowDeclarations(
  capability: Pick<
    CapabilityDefinition,
    'id' | 'cancelWindow' | 'wifi' | 'confirmFirst' | 'surfaces'
  >
): void {
  const { id } = capability;
  if (capability.cancelWindow && !CANCEL_WINDOW_CAPABILITY_IDS.has(id)) {
    throw new Error(`Capability registry: "${id}" may not declare a cancel window.`);
  }
  if (capability.confirmFirst) {
    if (!CONFIRM_FIRST_CAPABILITY_IDS.has(id)) {
      throw new Error(`Capability registry: "${id}" may not declare a confirm-first hold.`);
    }
    if (capability.surfaces.http?.audience !== 'person') {
      throw new Error(
        `Capability registry: "${id}" is confirm-first, so only a person may call it.`
      );
    }
  }
  if (capability.wifi === undefined) return;
  if (WIFI_MODE_CAPABILITY_IDS.get(id) !== capability.wifi) {
    throw new Error(`Capability registry: "${id}" may not run from a sign-in on your network.`);
  }
  if (capability.wifi === 'person-held' && capability.surfaces.http?.audience !== 'person') {
    throw new Error(`Capability registry: "${id}" is person-held, so only a person may call it.`);
  }
}
