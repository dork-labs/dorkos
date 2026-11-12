/**
 * Who is choosing where a chat runs over HTTP, and the ceiling their launch
 * carries (DOR-3644). Its own module so `sessions.ts` stays under its size
 * limit.
 *
 * @module routes/session-launcher
 */
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { isPersonTurn } from '../lib/caller-authority.js';
import { wifiTurnCeiling } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { carriedHoldOf, markedBoundOf } from '../services/core/turn-power/turn-levels.js';
import type { MeshCore } from '@dorkos/mesh';
import { boundaryRefusal, errorBody } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { auditRefusedLaunch } from '../services/session/launch/launch-audit.js';
import { getDirectChats } from '../services/rooms/direct-chat/index.js';
import { unprovenDirectChatBound } from './room-post-bound.js';
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
function sessionLauncherOf(facts: RequestFacts): SessionLauncher {
  if (isPersonTurn(facts)) return { kind: 'person' };
  const identity = facts.agentIdentity;
  if (identity && !identity.inactive) return { kind: 'agent', agentPath: identity.agentPath };
  return { kind: 'unidentified' };
}

/**
 * The ceiling and marks a message's turn carries, as the spread a launch takes:
 * the Wi-Fi hold on this request (DOR-3037), and for an agent the marks its own
 * running turns carry, so a marked turn cannot launder them through the API the
 * way `session_start` already cannot (DOR-3644 control 4). Every bound holds.
 * An agent's Wi-Fi hold rides as a mark, never a ceiling (DOR-3561).
 *
 * @param launcher - Who is posting.
 * @param facts - The request's facts.
 */
export function launcherTurnCeiling(
  launcher: SessionLauncher,
  facts: RequestFacts
): { permissionCeiling?: TurnPermissionCeiling; carriedMarks?: { outsider: true } } {
  const agentPath = launcher.kind === 'agent' ? launcher.agentPath : undefined;
  const carried = agentPath !== undefined ? carriedHoldOf(undefined, agentPath) : {};
  const bounds = [
    wifiTurnCeiling(facts).permissionCeiling,
    agentPath !== undefined ? markedBoundOf(undefined, agentPath) : undefined,
  ].flatMap((ceiling): readonly TurnPermissionBound[] =>
    ceiling === undefined ? [] : Array.isArray(ceiling) ? ceiling : [ceiling as TurnPermissionBound]
  );
  if (bounds.length === 0) return carried;
  return { permissionCeiling: bounds.length === 1 ? bounds[0]! : bounds, ...carried };
}

/**
 * What `POST /:id/messages` hands the launch service about its caller: who
 * chose the place, and the ceiling the turn carries. The route names the
 * origin itself, at the call. A message into a Direct chat's own session that
 * doesn't prove the owner is held to the stranger's bound too, exactly as a room
 * post into that chat is (DOR-3088, `unprovenDirectChatBound`).
 *
 * @param facts - The request's facts.
 * @param sessionId - The session the message is for, to tell whether it is a Direct chat's own.
 */
export function httpLaunchOf(
  facts: RequestFacts,
  sessionId?: string
): {
  launcher: SessionLauncher;
  permissionCeiling?: TurnPermissionCeiling;
  carriedMarks?: { outsider: true };
} {
  const launcher = sessionLauncherOf(facts);
  const turn = launcherTurnCeiling(launcher, facts);
  const directChat = sessionId !== undefined && getDirectChats()?.forSession(sessionId) != null;
  const unproven = directChat ? unprovenDirectChatBound(facts, launcher.kind) : undefined;
  if (!unproven) return { launcher, ...turn };
  const existing = turn.permissionCeiling;
  const bounds: readonly TurnPermissionBound[] =
    existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing
        : [existing as TurnPermissionBound];
  return { launcher, ...turn, permissionCeiling: bounds.length ? [...bounds, unproven] : unproven };
}

/**
 * Where a fork that names no folder runs (DOR-4060): a verified agent's own
 * folder, never the server's default, which is often the person's home folder.
 * Anyone else keeps the default, and the place rule then decides.
 *
 * @param facts - The request's facts.
 * @param fallback - The server's default folder.
 */
function forkDefaultCwd(facts: RequestFacts, fallback: string): string {
  const launcher = sessionLauncherOf(facts);
  return launcher.kind === 'agent' ? launcher.agentPath : fallback;
}

/**
 * Why this caller may not fork a chat into `cwd`, as the `403` body, or
 * `undefined` when it may: outside the boundary, or a place the caller may not
 * run a chat, by the same rule a new chat's folder meets (the fork runs there).
 *
 * @param facts - The request's facts.
 * @param meshCore - Mesh, which lists the registered homes.
 * @param cwd - Where the fork would run.
 * @param sessionId - The chat being forked, for the audit record.
 * @param defaulted - True when the request named no folder.
 */
async function forkPlaceRefusal(
  facts: RequestFacts,
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  cwd: string,
  sessionId: string,
  defaulted = false
): Promise<object | undefined> {
  const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
  if (outside) return outside;
  const launcher = sessionLauncherOf(facts);
  const place = launchPlaceRefusal(meshCore, launcher, { cwd, defaulted });
  if (!place) return undefined;
  auditRefusedLaunch(sessionId, place, launchedByOf(meshCore, launcher), { cwd }, 'session.fork');
  return errorBody(place.message, place.code === 'PROTECTED_FOLDER' ? place.code : 'DESK_NOT_OWN');
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

/**
 * Where a fork runs, and why it may not, as the route answers it: the folder
 * the request names, else (DOR-4060) a verified agent's own folder, else the
 * server's default, and the place rule's `403` body when it refuses.
 *
 * @param c - The request, for its facts and its `cwd` query.
 * @param meshCore - Mesh, which lists the registered homes.
 * @param sessionId - The chat being forked.
 */
export async function forkPlace(
  c: Context<ApiEnv>,
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  sessionId: string
): Promise<{ cwd: string; refused?: object }> {
  const facts = honoRequestFacts(c);
  const query = readQuery(c).cwd;
  const named = typeof query === 'string' && query !== '' ? query : undefined;
  const cwd = named ?? forkDefaultCwd(facts, DEFAULT_CWD);
  const refused = await forkPlaceRefusal(facts, meshCore, cwd, sessionId, named === undefined);
  return refused ? { cwd, refused } : { cwd };
}
