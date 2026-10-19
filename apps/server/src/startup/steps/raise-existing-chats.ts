/**
 * Startup step: wire the chat-mode port and run the one-time raise of existing
 * chats to their agent's level (DOR-3107, `existing-chats-raise.ts`). Runs after
 * the person-set floor is seeded, since that is the level a chat is raised to.
 *
 * @module startup/steps/raise-existing-chats
 */
import path from 'node:path';

import { sessionMetadata, type Db } from '@dorkos/db';
import { eq } from 'drizzle-orm';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';

import { logger } from '../../lib/logger.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { permissionGateSources } from '../../services/core/capabilities/permission-enforcement.js';
import {
  raiseExistingChats,
  setChatModePort,
  type ChatModePort,
} from '../../services/core/permissions/existing-chats-raise.js';
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
  activity: Pick<ActivityService, 'emit'>;
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
      if (runtime.hasSession(internal)) {
        const updated = await runtime.updateSession(internal, { permissionMode: next });
        if (!updated.updated) throw new Error('the session was not found');
        return;
      }
      await runtimeRegistry.saveSessionSettings(sessionId, { permissionMode: next });
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
      logger,
    });
  } catch (err) {
    logger.warn('[Permissions] the raise of existing chats did not run', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
