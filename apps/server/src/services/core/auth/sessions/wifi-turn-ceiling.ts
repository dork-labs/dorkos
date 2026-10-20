/**
 * The turn cap for Wi-Fi (DOR-3037; plan `2026-10-accounts-and-devices`).
 *
 * A Wi-Fi sign-in reaches DorkOS over plain `http` on the local network, where
 * anyone on the same network can watch or relay the traffic (`./wifi-level.ts`).
 * So a turn a Wi-Fi request starts runs at the receiving runtime's default
 * level at most, whatever the agent's own level: every file or shell step asks,
 * and from Wi-Fi the only answers are Allow once or Deny.
 *
 * The cap is the session relay's ({@link WIFI_TURN_CEILING} is the bound
 * `RELAY_TURN_CEILING` uses), so it travels the way that one does: a turn held
 * to `'runtime-default'` is recorded as one that read words DorkOS cannot
 * vouch for, and that mark rides every turn it starts (a room post, a
 * `chat_send`, a `session_start`), and parks a schedule it creates for a
 * person to approve (`tasks_create`).
 *
 * A request is from Wi-Fi when the Wi-Fi listener admitted it, the same test
 * the Wi-Fi level uses ({@link isFromWifi}), never the cookie.
 *
 * @module services/core/auth/sessions/wifi-turn-ceiling
 */
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { ClassifierFacts } from '../../../../lib/request-classifier.js';
import { isFromWifi } from './wifi-level.js';

/** The bound a turn a Wi-Fi request starts runs under: the runtime's default. */
export const WIFI_TURN_CEILING = 'runtime-default' satisfies TurnPermissionBound;

/**
 * The bound a turn this request starts runs under: {@link WIFI_TURN_CEILING}
 * from Wi-Fi, `undefined` otherwise. For a room post, which keeps it with the
 * post until the replies it starts are dispatched.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function wifiTurnBound(facts: ClassifierFacts): 'runtime-default' | undefined {
  return isFromWifi(facts) ? WIFI_TURN_CEILING : undefined;
}

/**
 * The ceiling a turn this request starts carries, as the spread a dispatch
 * takes: {@link WIFI_TURN_CEILING} from Wi-Fi, nothing otherwise.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function wifiTurnCeiling(facts: ClassifierFacts): {
  permissionCeiling?: TurnPermissionCeiling;
} {
  return isFromWifi(facts) ? { permissionCeiling: WIFI_TURN_CEILING } : {};
}
