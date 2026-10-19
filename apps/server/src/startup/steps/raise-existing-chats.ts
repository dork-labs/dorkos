/**
 * Startup step: wire the chat-mode port and run the one-time raise of existing
 * chats to their agent's level (DOR-3107, `existing-chats-raise.ts`). Runs after
 * the person-set floor is seeded, since that is the level a chat is raised to.
 *
 * @module startup/steps/raise-existing-chats
 */
import path from 'node:path';

import {
  chatMessages,
  communityRoomMirrors,
  roomBridges,
  roomEntries,
  roomSessions,
  sessionMetadata,
  type Db,
} from '@dorkos/db';
import { and, asc, eq } from 'drizzle-orm';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { isNoLooserThan, levelOfMode } from '@dorkos/shared/permission-semantics';
import { PERMISSION_CHANGED_EVENT } from '@dorkos/shared/permissions';

import { logger } from '../../lib/logger.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { permissionGateSources } from '../../services/core/capabilities/permission-enforcement.js';
import {
  EXISTING_CHATS_NOTE,
  openingMessageMarked,
  raiseExistingChats,
  setChatModePort,
  type ChatModePort,
  type ExistingChatRow,
} from '../../services/core/permissions/existing-chats-raise.js';
import { hasMarks, parseStoredMarks } from '../../services/core/turn-power/turn-marks.js';
import type { PersonSetPermissions } from '../../services/core/permissions/person-set-permissions.js';
import type { PermissionAgentRef } from '../../services/core/permissions/permission-service.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import type { ServerRefs } from '../server-refs.js';
import { resolveUnattendedDefaultStop } from '../../services/session/resolution/resolve-session-defaults.js';

/** What the step needs. */
export interface RaiseExistingChatsInput {
  db: Db;
  dorkHome: string;
  personSet: PersonSetPermissions;
  activity: Pick<ActivityService, 'emit' | 'list'>;
  mesh: () => ServerRefs['meshCore'];
}

/** The registered agents, as the permission history names them. */
function agentsOf(mesh: ServerRefs['meshCore']): PermissionAgentRef[] {
  return (mesh?.listWithPaths() ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    ...(a.displayName ? { displayName: a.displayName } : {}),
    projectPath: a.projectPath,
  }));
}

/** How far back the history is searched for an earlier raise. */
const PRIOR_RAISE_DEPTH = 2_000;

/**
 * Whether the permission history already holds the raise of existing chats:
 * the second half of the done flag, for an install whose done file was lost.
 *
 * @param activity - The Activity reader.
 */
async function historyHoldsRaise(activity: Pick<ActivityService, 'list'>): Promise<boolean> {
  let cursor: string | undefined;
  for (let seen = 0; seen < PRIOR_RAISE_DEPTH;) {
    const page = await activity.list({
      limit: 100,
      categories: 'permissions',
      ...(cursor ? { before: cursor } : {}),
    });
    for (const row of page.items) {
      const note = (row.metadata as { note?: unknown } | null)?.note;
      if (row.eventType === PERMISSION_CHANGED_EVENT && note === EXISTING_CHATS_NOTE) return true;
      cursor = row.occurredAt;
    }
    seen += page.items.length;
    if (page.nextCursor === null || page.items.length === 0) return false;
  }
  return false;
}

/**
 * Whether what launched a chat was marked or came from outside (see
 * `ExistingChatsRaiseDeps.launchMarked`). A chat another chat's message opened
 * reads that message's stored sender level. A room chat is marked unless its
 * room is found, is not bridged to a chat app, is not a space's copy, and holds
 * no post whose kept marks carry one (a superset of the post that started it).
 * NULL post marks are unknown and do not count.
 *
 * @param db - The database.
 * @param row - The chat.
 */
export function launchMarkedIn(db: Db, row: ExistingChatRow): boolean {
  if (row.launchOrigin === 'chat-message') {
    const opener = db
      .select({ ceilingJson: chatMessages.ceilingJson })
      .from(chatMessages)
      .where(eq(chatMessages.toSessionId, row.sessionId))
      .orderBy(asc(chatMessages.createdAt))
      .limit(1)
      .get();
    return openingMessageMarked(opener?.ceilingJson);
  }
  if (row.launchOrigin !== 'room') return false;
  const seat = db
    .select({ roomId: roomSessions.roomId })
    .from(roomSessions)
    .where(eq(roomSessions.sessionId, row.sessionId))
    .get();
  if (!seat) return true;
  const roomId = seat.roomId;
  const bridged = db
    .select({ roomId: roomBridges.roomId })
    .from(roomBridges)
    .where(eq(roomBridges.roomId, roomId))
    .get();
  const mirrored = db
    .select({ roomId: communityRoomMirrors.localRoomId })
    .from(communityRoomMirrors)
    .where(eq(communityRoomMirrors.localRoomId, roomId))
    .get();
  if (bridged || mirrored) return true;
  const marks = db
    .select({ turnMarks: roomEntries.turnMarks })
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId)))
    .all();
  return marks.some((m) => m.turnMarks !== null && hasMarks(parseStoredMarks(m.turnMarks)));
}

/**
 * The chat-mode port over the session-settings path: a chat the runtime holds
 * live is changed through `updateSession`, exactly as a person's mode change
 * is, and any other is written to its stored settings, which is the write
 * `updateSession` makes first. Never through `updateSession` for a chat that is
 * not live: that would load hundreds of idle chats into the runtime's memory.
 *
 * @param db - The database, read for a chat's stored mode.
 */
export function sessionSettingsChatModePort(db: Db): ChatModePort {
  return {
    modeOf: (sessionId) => {
      const row = db
        .select({ mode: sessionMetadata.permissionMode })
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .get();
      return row ? (row.mode ?? null) : 'gone';
    },
    setMode: async (sessionId, mode) => {
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      const next = mode ?? runtime.getCapabilities().permissionModes?.default;
      if (!next) throw new Error(`no mode to set for ${runtime.type}`);
      const internal = runtime.getInternalSessionId(sessionId) ?? sessionId;
      const live = async () => {
        const updated = await runtime.updateSession(internal, { permissionMode: next });
        if (!updated.updated) throw new Error('the session was not found');
      };
      if (runtime.hasSession(internal)) return live();
      await runtimeRegistry.saveSessionSettings(sessionId, { permissionMode: next });
      // A turn may have loaded the chat between the check and the write; it
      // read the old mode, so it is told the new one the way a person's change is.
      if (runtime.hasSession(internal)) await live();
    },
    isLooser: async (sessionId, candidate, than) => {
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      const declared = runtime.getCapabilities().permissionModes;
      if (!declared) return true;
      const a = levelOfMode(declared, candidate ?? declared.default);
      const b = levelOfMode(declared, than ?? declared.default);
      if (!a || !b) return true;
      return !isNoLooserThan(b, a);
    },
  };
}

/**
 * Wire the port and run the raise. Never throws: a failure is logged and the
 * server starts as it would have.
 *
 * @param input - The database, data directory, person-set record, Activity writer and Mesh.
 */
export async function raiseExistingChatsOnBoot(input: RaiseExistingChatsInput): Promise<void> {
  const port = sessionSettingsChatModePort(input.db);
  setChatModePort(port);
  try {
    await raiseExistingChats({
      doneFile: path.join(input.dorkHome, 'permissions', 'existing-chats-raised.json'),
      chats: () =>
        input.db
          .select({
            sessionId: sessionMetadata.sessionId,
            runtime: sessionMetadata.runtime,
            agentPath: sessionMetadata.agentPath,
            launchOrigin: sessionMetadata.launchOrigin,
            permissionMode: sessionMetadata.permissionMode,
          })
          .from(sessionMetadata)
          .all(),
      agents: () => agentsOf(input.mesh()),
      launchMarked: (row) => launchMarkedIn(input.db, row),
      personSet: input.personSet,
      defaultStop: (runtime) =>
        resolveUnattendedDefaultStop({
          configSection: runtimeRegistry.has(runtime)
            ? (runtimeRegistry.get(runtime).getCapabilities().settings?.configSection ?? null)
            : null,
        }),
      agentStop: async (agentPath): Promise<PermissionStop | undefined> =>
        (await permissionGateSources().readAgentPermissions(agentPath))?.filesAndCommands,
      modes: (runtime) =>
        runtimeRegistry.has(runtime)
          ? runtimeRegistry.get(runtime).getCapabilities().permissionModes
          : undefined,
      port,
      activity: input.activity,
      priorRaise: () => historyHoldsRaise(input.activity),
      logger,
    });
  } catch (err) {
    logger.warn('[Permissions] the raise of existing chats did not run', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
