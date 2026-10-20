/**
 * Startup step: wire the chat-mode port and run the one-time raises of existing
 * chats to their agent's level (`existing-chats-raise.ts`): every chat of our own
 * (DOR-3107), then the chats agents started for themselves (DOR-3147), each
 * under its own note and done file. Runs after the person-set floor is seeded,
 * since that is the level a chat is raised to.
 *
 * @module startup/steps/raise-existing-chats
 */
import path from 'node:path';

import { sessionMetadata, type Db } from '@dorkos/db';
import { eq } from 'drizzle-orm';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { isNoLooserThan, levelOfMode } from '@dorkos/shared/permission-semantics';
import { PERMISSION_CHANGED_EVENT } from '@dorkos/shared/permissions';

import { logger } from '../../lib/logger.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { permissionGateSources } from '../../services/core/capabilities/permission-enforcement.js';
import {
  EXISTING_CHATS_NOTE,
  raiseExistingChats,
  setChatModePort,
  SPIN_OFF_CHATS_NOTE,
  SPIN_OFF_ORIGINS,
  type ChatModePort,
} from '../../services/core/permissions/existing-chats-raise.js';
import { chatLaunchMarks } from '../../services/core/permissions/chat-launch-marks.js';
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
 * Whether the permission history already holds a raise of existing chats: the
 * second half of the done flag, for an install whose done file was lost.
 *
 * @param activity - The Activity reader.
 * @param raiseNote - The note that raise's history event carries.
 */
async function historyHoldsRaise(
  activity: Pick<ActivityService, 'list'>,
  raiseNote: string
): Promise<boolean> {
  let cursor: string | undefined;
  for (let seen = 0; seen < PRIOR_RAISE_DEPTH;) {
    const page = await activity.list({
      limit: 100,
      categories: 'permissions',
      ...(cursor ? { before: cursor } : {}),
    });
    for (const row of page.items) {
      const note = (row.metadata as { note?: unknown } | null)?.note;
      if (row.eventType === PERMISSION_CHANGED_EVENT && note === raiseNote) return true;
      cursor = row.occurredAt;
    }
    seen += page.items.length;
    if (page.nextCursor === null || page.items.length === 0) return false;
  }
  return false;
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

/** The one-time raises, in order: each runs once per install, by its own done file and note. */
const RAISES: ReadonlyArray<{ doneFile: string; note: string; origins?: ReadonlySet<string> }> = [
  { doneFile: 'existing-chats-raised.json', note: EXISTING_CHATS_NOTE },
  { doneFile: 'spin-off-chats-raised.json', note: SPIN_OFF_CHATS_NOTE, origins: SPIN_OFF_ORIGINS },
];

/**
 * Wire the port and run the raises. Never throws: a failure is logged and the
 * server starts as it would have.
 *
 * @param refs - The server's live references, for Mesh.
 * @param input - The database, data directory, person-set record and Activity writer.
 */
export async function raiseExistingChatsOnBoot(
  refs: ServerRefs,
  input: RaiseExistingChatsInput
): Promise<void> {
  const port = sessionSettingsChatModePort(input.db);
  setChatModePort(port);
  const launchMarked = chatLaunchMarks(input.db, true);
  for (const raise of RAISES) await runRaise(refs, input, port, launchMarked, raise);
}

/** Run one raise. Never throws. */
async function runRaise(
  refs: ServerRefs,
  input: RaiseExistingChatsInput,
  port: ChatModePort,
  launchMarked: ReturnType<typeof chatLaunchMarks>,
  raise: (typeof RAISES)[number]
): Promise<void> {
  try {
    await raiseExistingChats({
      doneFile: path.join(input.dorkHome, 'permissions', raise.doneFile),
      note: raise.note,
      ...(raise.origins ? { origins: raise.origins } : {}),
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
      agents: () => agentsOf(refs.meshCore),
      launchMarked: (row) => launchMarked(row.sessionId, row.launchOrigin),
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
      priorRaise: () => historyHoldsRaise(input.activity, raise.note),
      logger,
    });
  } catch (err) {
    logger.warn('[Permissions] a raise of existing chats did not run', {
      note: raise.note,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
