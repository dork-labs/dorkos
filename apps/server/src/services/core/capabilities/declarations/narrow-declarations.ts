/**
 * Declarations only a reviewed list of capabilities may make. Each one lets a
 * call skip a protection every other capability keeps, so `composeRegistry`
 * refuses it on any id not named here, and a new one is a reviewed edit.
 *
 * @module services/core/capabilities/declarations/narrow-declarations
 */
import type { CapabilityDefinition, CapabilityWifiMode } from '../capability-definition.js';
import type { ConfirmFirstBar } from './confirm-first.js';

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
 * ADR 261125-114705, decision 4), each with the one bar it must declare: a
 * person's write the person confirms on the "Confirm it's you" sheet.
 *
 * - `heartbeat.choose_triage_credits` (`account-owner`): using DorkOS credits
 *   for heartbeat checks.
 * - `mcp.add_global_server`, `mcp.replace_global_server` (`front-door`): what
 *   an MCP server every agent gets runs (DOR-4978).
 * - `connectors.let_agent_back_in`, `connectors.answer_agent_request` (a yes
 *   only), `connectors.start_agent_request_sign_in` (`front-door`, behind the
 *   account-decision caller bar): giving an agent access to a connected app
 *   (DOR-4355, DOR-4978).
 */
export const CONFIRM_FIRST_CAPABILITY_IDS: ReadonlyMap<string, ConfirmFirstBar> = new Map([
  ['heartbeat.choose_triage_credits', 'account-owner'],
  ['mcp.add_global_server', 'front-door'],
  ['mcp.replace_global_server', 'front-door'],
  ['connectors.let_agent_back_in', 'front-door'],
  ['connectors.answer_agent_request', 'front-door'],
  ['connectors.start_agent_request_sign_in', 'front-door'],
]);

/**
 * Refuse a core capability that makes a narrow declaration it is not listed for.
 *
 * @param capability - The capability being composed.
 * @throws When it declares `cancelWindow`, a `wifi` mode or `confirmFirst`
 *   without being listed for it, a caller bar it may not ({@link assertCallerBar}), a confirm-first bar other than its listed one, or `person-held` or `confirmFirst` on a
 *   capability any agent may call.
 */
export function assertNarrowDeclarations(
  capability: Pick<
    CapabilityDefinition,
    'id' | 'cancelWindow' | 'wifi' | 'confirmFirst' | 'surfaces'
  >
): void {
  const { id } = capability;
  assertCallerBar(capability);
  if (capability.cancelWindow && !CANCEL_WINDOW_CAPABILITY_IDS.has(id)) {
    throw new Error(`Capability registry: "${id}" may not declare a cancel window.`);
  }
  if (capability.confirmFirst) {
    const bar = CONFIRM_FIRST_CAPABILITY_IDS.get(id);
    if (bar === undefined) {
      throw new Error(`Capability registry: "${id}" may not declare a confirm-first hold.`);
    }
    if (capability.confirmFirst.bar !== bar) {
      throw new Error(`Capability registry: "${id}" must declare the ${bar} confirm-first bar.`);
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

/**
 * Refuse a caller bar (`http.callerBar`, DOR-4978) anywhere an agent could
 * reach it or the bar would mean less: it needs `audience: 'person'` (so every
 * list an agent reads shows it closed to agents), and takes no MCP surface and
 * no network mode. It takes a confirm-first hold only behind the `front-door`
 * bar (Security t1j, 2026-11-27): the mount runs the caller bar afresh on the
 * confirming request, refuses a confirm from another kind of caller, and keeps
 * no pass with the hold (`routes/capability-confirm-first.ts`). Never with the
 * `account-owner` hold, which runs its own owner bar in its own words. Each
 * bar names its own fixed words: `account-decision` its `owner_only`
 * sentence, `person` its copy; neither takes the other's.
 *
 * @param capability - The capability being composed.
 * @throws Naming what the declaration may not have.
 */
function assertCallerBar(
  capability: Pick<CapabilityDefinition, 'id' | 'wifi' | 'confirmFirst' | 'surfaces'>
): void {
  const { id, surfaces } = capability;
  const http = surfaces.http;
  const bar = http?.callerBar;
  const fail = (why: string): never => {
    throw new Error(`Capability registry: "${id}" ${why}.`);
  };
  if (http?.ownerOnly !== undefined && bar !== 'account-decision') {
    fail('names an owner sentence but not the account-decision bar');
  }
  if (http?.personCopy !== undefined && bar !== 'person') {
    fail('names person bar copy but not the person bar');
  }
  if (bar === undefined) return;
  if (http!.audience !== 'person') fail('has a caller bar, so only a person may call it');
  if (bar === 'account-decision' && http!.ownerOnly === undefined) {
    fail('has the account-decision bar, so it names its own sentence');
  }
  if (bar === 'person' && http!.personCopy === undefined) {
    fail('has the person bar, so it names its own copy');
  }
  if (surfaces.mcp !== undefined) fail('has a caller bar, so it has no MCP surface');
  if (capability.wifi !== undefined) fail('has a caller bar, so it has no network mode');
  if (capability.confirmFirst !== undefined && capability.confirmFirst.bar !== 'front-door') {
    fail('has a caller bar, so its confirm-first hold takes the front-door bar');
  }
}
