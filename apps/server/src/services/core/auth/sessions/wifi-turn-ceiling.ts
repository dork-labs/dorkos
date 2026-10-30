/**
 * The turn cap for Wi-Fi (DOR-3037; plan `2026-10-accounts-and-devices`).
 *
 * A Wi-Fi sign-in reaches DorkOS over plain `http` on the local network, where
 * anyone on the same network can watch or relay the traffic (`./wifi-level.ts`).
 * So a turn a Wi-Fi request starts runs at the receiving runtime's default
 * level at most, whatever the agent's own level: every file or shell step asks,
 * and from Wi-Fi the only answers are Allow once or Deny.
 *
 * **Except the owner's own words (DOR-3242).** The owner chose to have their
 * own messages from Wi-Fi count as theirs, ahead of HTTPS on that path
 * (DOR-3173). A request is the owner's own when the session gate verified the
 * owner's sign-in cookie on it, made on the Wi-Fi route, with no agent header
 * beside it, sent by the app's own page ({@link isOwnerOnWifi}). Anything else
 * from Wi-Fi is still held: an API key, no sign-in, a teammate, an agent, or a
 * page on another site riding the cookie. What a person on Wi-Fi may *change*
 * is decided elsewhere and is unchanged (`./wifi-raise-guard.ts`,
 * `./wifi-level.ts`), and an irreversible action in a connected app still
 * waits for a yes at the computer while Wi-Fi is plain `http`
 * (`connectors/execution/destructive-hold-window.ts`).
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
import type { RequestFacts } from '../../../../http/request-facts.js';
import { presentsAgentIdentity } from '../../../../middleware/agent-identity.js';
import { readOwnerAccount } from '../index.js';
import { isFromWifi } from './wifi-level.js';

/** The bound a turn a Wi-Fi request starts runs under: the runtime's default. */
export const WIFI_TURN_CEILING = 'runtime-default' satisfies TurnPermissionBound;

/** The facts the hold reads: where the request came from, and who it proved. */
export type WifiTurnFacts = Pick<
  RequestFacts,
  'headers' | 'peerAddress' | 'ingress' | 'user' | 'agentIdentity'
>;

/**
 * Whether the app's own page sent the request: no `Sec-Fetch-Site` but
 * `same-origin`, and no `Origin` but this host over plain `http`, the only
 * scheme the Wi-Fi listener serves. A page on any other site that rides the
 * owner's cookie fails one or the other.
 */
function fromOwnPage(headers: RequestFacts['headers']): boolean {
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const { origin, host } = headers;
  return origin === undefined || (host !== undefined && origin === `http://${host}`);
}

/**
 * Whether a Wi-Fi request is the owner's own: the owner's sign-in cookie,
 * verified on this request and made on the Wi-Fi route, with no agent header,
 * from the app's own page. No registered owner means nobody's is.
 *
 * @param facts - The request's facts.
 */
function isOwnerOnWifi(facts: WifiTurnFacts): boolean {
  const { user } = facts;
  if (user?.credential !== 'cookie' || user.route !== 'wifi') return false;
  if (presentsAgentIdentity(facts) || !fromOwnPage(facts.headers)) return false;
  const owner = readOwnerAccount();
  return owner !== null && owner.id === user.userId;
}

/**
 * Whether a turn this request starts is held to {@link WIFI_TURN_CEILING}: it
 * came from Wi-Fi and is not the owner's own (DOR-3242). The one place that
 * decides it; every route that starts or rewords a turn asks here.
 *
 * @param facts - The request's facts.
 */
export function wifiTurnHeld(facts: WifiTurnFacts): boolean {
  return isFromWifi(facts) && !isOwnerOnWifi(facts);
}

/**
 * The bound a turn this request starts runs under: {@link WIFI_TURN_CEILING}
 * when {@link wifiTurnHeld}, `undefined` otherwise. For a room post, which
 * keeps it with the post until the replies it starts are dispatched.
 *
 * @param facts - The request's facts.
 */
export function wifiTurnBound(facts: WifiTurnFacts): 'runtime-default' | undefined {
  return wifiTurnHeld(facts) ? WIFI_TURN_CEILING : undefined;
}

/**
 * The ceiling a turn this request starts carries, as the spread a dispatch
 * takes: {@link WIFI_TURN_CEILING} when {@link wifiTurnHeld}, nothing otherwise.
 *
 * @param facts - The request's facts.
 */
export function wifiTurnCeiling(facts: WifiTurnFacts): {
  permissionCeiling?: TurnPermissionCeiling;
} {
  return wifiTurnHeld(facts) ? { permissionCeiling: WIFI_TURN_CEILING } : {};
}
