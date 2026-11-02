/**
 * Who is choosing where a chat runs over HTTP, and the ceiling their launch
 * carries (DOR-3644). Its own module so `sessions.ts` stays under its size
 * limit.
 *
 * @module routes/session-launcher
 */
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { RequestFacts } from '../http/request-facts.js';
import { isPersonTurn } from '../lib/caller-authority.js';
import { wifiTurnCeiling } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { markedBoundOf } from '../services/core/turn-power/turn-levels.js';
import type { MeshCore } from '@dorkos/mesh';
import { boundaryRefusal, errorBody } from '../lib/route-utils.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { auditRefusedLaunch } from '../services/session/launch/launch-audit.js';
import {
  launchedByOf,
  launchPlaceRefusal,
  type LaunchPlaceRefusal,
  type SessionLauncher,
} from '../services/session/launch/launch-caller.js';

/**
 * The caller, as the launch place rule reads it: the person's own turn
 * ({@link isPersonTurn}), an agent whose token verified and is live, or
 * anything else. A revoked or expired token names nobody here, so dropping a
 * credential never reaches further than having none.
 *
 * @param facts - The request's facts.
 */
export function sessionLauncherOf(facts: RequestFacts): SessionLauncher {
  if (isPersonTurn(facts)) return { kind: 'person' };
  const identity = facts.agentIdentity;
  if (identity && !identity.inactive) return { kind: 'agent', agentPath: identity.agentPath };
  return { kind: 'unidentified' };
}

/**
 * The ceiling a message's turn carries, as the spread a launch takes: the
 * Wi-Fi hold (DOR-3037), and for an agent the marks its own running turns
 * carry, so a marked turn cannot launder them through the API the way
 * `session_start` already cannot (DOR-3644 control 4). Every bound holds.
 *
 * @param launcher - Who is posting.
 * @param facts - The request's facts.
 */
export function launcherTurnCeiling(
  launcher: SessionLauncher,
  facts: RequestFacts
): { permissionCeiling?: TurnPermissionCeiling } {
  const bounds = [
    wifiTurnCeiling(facts).permissionCeiling,
    launcher.kind === 'agent' ? markedBoundOf(undefined, launcher.agentPath) : undefined,
  ].flatMap((ceiling): readonly TurnPermissionBound[] =>
    ceiling === undefined ? [] : Array.isArray(ceiling) ? ceiling : [ceiling as TurnPermissionBound]
  );
  if (bounds.length === 0) return {};
  return { permissionCeiling: bounds.length === 1 ? bounds[0]! : bounds };
}

/**
 * What `POST /:id/messages` hands the launch service about its caller: who
 * chose the place, and the ceiling the turn carries. The route names the
 * origin itself, at the call.
 *
 * @param facts - The request's facts.
 */
export function httpLaunchOf(facts: RequestFacts): {
  launcher: SessionLauncher;
  permissionCeiling?: TurnPermissionCeiling;
} {
  const launcher = sessionLauncherOf(facts);
  return { launcher, ...launcherTurnCeiling(launcher, facts) };
}

/**
 * Why this caller may not fork a chat into `cwd`, as the `403` body, or
 * `undefined` when it may: outside the boundary, or a place the caller may not
 * run a chat, by the same rule a new chat's folder meets (the fork runs there).
 *
 * @param facts - The request's facts.
 * @param meshCore - Mesh, which lists the registered homes.
 * @param cwd - Where the fork would run.
 */
export async function forkPlaceRefusal(
  facts: RequestFacts,
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  cwd: string,
  sessionId: string
): Promise<object | undefined> {
  const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
  if (outside) return outside;
  const launcher = sessionLauncherOf(facts);
  const place = launchPlaceRefusal(meshCore, launcher, { cwd });
  if (!place) return undefined;
  auditRefusedLaunch(sessionId, place, launchedByOf(meshCore, launcher), { cwd }, 'session.fork');
  return errorBody(place.message, 'DESK_NOT_OWN');
}

/**
 * Why this caller may not touch a message waiting in this chat, or `null` when
 * it may: the same place rule a new message meets, asked of the chat's
 * recorded agent and, when the runtime knows it, its folder (DOR-3644 S1).
 *
 * @param facts - The request's facts.
 * @param meshCore - Mesh, which lists the registered homes.
 * @param sessionId - The chat.
 */
export async function chatPlaceRefusal(
  facts: RequestFacts,
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  sessionId: string
): Promise<LaunchPlaceRefusal | null> {
  const launcher = sessionLauncherOf(facts);
  if (launcher.kind === 'person') return null;
  // An unreadable record names an agent nobody can be: refuse, never guess.
  const chatAgent = await runtimeRegistry
    .getSessionAgentPath(sessionId)
    .catch(() => 'unreadable' as const);
  const cwd = runtimeRegistry.getNativeSessionCwd?.(sessionId) ?? undefined;
  const place = { chatAgent, ...(cwd ? { cwd } : {}) };
  const refusal = launchPlaceRefusal(meshCore, launcher, place);
  if (refusal) {
    auditRefusedLaunch(
      sessionId,
      refusal,
      launchedByOf(meshCore, launcher),
      place,
      'session.queue'
    );
  }
  return refusal;
}
