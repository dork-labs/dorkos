/**
 * The relay request server's dependencies, wired to the live server: Mesh,
 * the runtime registry, the session-origin overlays, the launch service, the
 * durable stream and the audit trail.
 *
 * Everything is read when a request arrives, never when this module loads, and
 * nothing is cached between requests. Until the server has handed over its
 * startup pieces ({@link SessionRelayWiring}) there are no agents, so every
 * request is answered as not found.
 *
 * @module services/core/session-relay/live-deps
 */
import type { MeshCore } from '@dorkos/mesh';
import type { Session } from '@dorkos/shared/types';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { boundaryRefusal } from '../../../lib/route-utils.js';
import { parseResumeCursor } from '../../../lib/stream-cursor.js';
import { auditTrail, recordAudit } from '../../audit/audit-trail.js';
import { runtimeRegistry } from '../runtime-registry.js';
import { deliverSessionStream } from '../streams/session-stream-delivery.js';
import { aggregateSessionList } from '../../session/catalog/aggregate-session-list.js';
import { dispatchSessionMessage } from '../../session/launch/launch-session.js';
import { sessionExists } from '../../session/launch/session-exists.js';
import {
  applySessionOriginOverlays,
  type SessionOriginResolvers,
} from '../../session/origin/session-origin-overlays.js';
import { clearQueuedMessages } from '../../session/queued-message-edits.js';
import { resolveSessionCwdOrNull } from '../../session/resolution/resolve-read-cwd.js';
import { resolveSettingsKey } from '../../session/resolution/session-settings-overlay.js';
import { peekProjector } from '../../session/session-state-projector.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import type { PendingApprovalCard } from './approval-challenges.js';
import { bumpSignCount, readApprovalKeys } from './approval-key-store.js';
import { readRelayPin } from './pin-store.js';
import { relayApprovableCard } from './relay-approvable.js';
import type { RelayRequestServerDeps } from './relay-request-server.js';
import type { RelayAgent, RelaySessionFacts } from './relay-serves.js';

/** What the server hands the relay once its startup pieces exist. */
export interface SessionRelayWiring {
  /** Mesh, when it is running. */
  meshCore: () => MeshCore | undefined;
  /** The session-origin lookups the session routes use (rooms, tasks, beats). */
  origins: SessionOriginResolvers;
  /** The room binding port the send path takes. */
  roomSessionPlace: () => RoomSessionPlacePort | undefined;
}

/** The name the audit log gives the owner when no trail is set up. */
const OWNER_FALLBACK = { accountId: 'owner', kind: 'person', name: 'Owner' } as const;

/** The owner as the audit log names them: every relayed action is recorded as theirs. */
export function relayOwnerActor(): AuditActor {
  return auditTrail()?.accounts.owner() ?? { ...OWNER_FALLBACK };
}

/**
 * The request server's dependencies, reading the wiring on every call.
 *
 * @param wiring - The startup pieces, or `null` before the server handed them over.
 */
export function liveRelayDeps(wiring: () => SessionRelayWiring | null): RelayRequestServerDeps {
  const origins = (): SessionOriginResolvers | undefined => wiring()?.origins;

  /** Whether a room, a task or a beat owns any of these ids. */
  const ownedBy = (ids: string[]): RelaySessionFacts['ownedBy'] => {
    const resolvers = origins();
    return {
      room: (resolvers?.resolveRoomOrigins?.(ids).size ?? 0) > 0,
      task: (resolvers?.resolveTaskOrigins?.(ids).size ?? 0) > 0,
      beat: (resolvers?.resolveBeatChats?.(ids).size ?? 0) > 0,
    };
  };

  /** A folder, or `null` when the boundary refuses it. */
  const inBoundary = async (cwd: string | null): Promise<string | null> =>
    cwd !== null && !(await boundaryRefusal(cwd, { allowDorkHome: true })) ? cwd : null;

  /** One listed or located row with its origin overlays applied. */
  const overlaid = (row: Session | null): Session | null => {
    const resolvers = origins();
    if (row && resolvers) applySessionOriginOverlays([row], resolvers);
    return row;
  };

  return {
    agents: (): RelayAgent[] => {
      const mesh = wiring()?.meshCore();
      if (!mesh) return [];
      return mesh.listWithPaths().map((agent) => {
        const manifest = mesh.get(agent.id);
        // An agent whose manifest cannot be read is treated as a system one.
        return {
          id: agent.id,
          projectPath: agent.projectPath,
          isSystem: !manifest || manifest.isSystem === true,
        };
      });
    },

    locateSession: async (sessionId) => {
      if (!(await sessionExists(sessionId))) return null;
      const runtime = await runtimeRegistry.resolveForSession(sessionId, { allowUnbound: true });
      const key = resolveSettingsKey(sessionId, runtime);
      const internalId = runtime.getInternalSessionId(sessionId) ?? sessionId;
      const cwd = await inBoundary(await resolveSessionCwdOrNull(runtime, sessionId, undefined));
      const row = cwd === null ? null : await runtime.getSession(cwd, internalId);
      return {
        sessionId,
        cwd,
        agentPath: await runtimeRegistry.getSessionAgentPath(key),
        launchOrigin: runtimeRegistry.getSessionLaunchOrigin(key),
        row: overlaid(row),
        ownedBy: ownedBy([...new Set([sessionId, internalId, key])]),
      };
    },

    listAgentSessions: async (agent) => {
      const projectDir = await inBoundary(agent.projectPath);
      if (projectDir === null) return [];
      const { sessions } = await aggregateSessionList({
        runtimes: runtimeRegistry.listRuntimes(),
        projectDir,
      });
      const resolvers = origins();
      if (resolvers) applySessionOriginOverlays(sessions, resolvers);
      // One batched lookup per table for the whole list, not one per chat.
      const ids = sessions.map((session) => session.id);
      const rooms = resolvers?.resolveRoomOrigins?.(ids);
      const tasks = resolvers?.resolveTaskOrigins?.(ids);
      const beats = resolvers?.resolveBeatChats?.(ids);
      return Promise.all(
        sessions.map(async (row) => ({
          sessionId: row.id,
          cwd: await inBoundary(row.cwd ?? projectDir),
          agentPath: await runtimeRegistry.getSessionAgentPath(row.id),
          launchOrigin: runtimeRegistry.getSessionLaunchOrigin(row.id),
          row,
          ownedBy: {
            room: rooms?.has(row.id) ?? false,
            task: tasks?.has(row.id) ?? false,
            beat: beats?.has(row.id) ?? false,
          },
        }))
      );
    },

    resolveStreamPlan: async (facts, resume) => {
      const runtime = await runtimeRegistry.resolveForSession(facts.sessionId, {
        allowUnbound: true,
      });
      const stored = await runtimeRegistry.getSessionSettings(
        resolveSettingsKey(facts.sessionId, runtime)
      );
      if (facts.cwd === null) throw new Error('A relayed stream needs a placed chat');
      return {
        sessionId: facts.sessionId,
        runtime,
        ctx: { cwd: facts.cwd, permissionMode: stored?.permissionMode ?? 'default' },
        // The whole frame id, bound to this chat, exactly as `?resume=` is.
        resume: parseResumeCursor(resume, undefined, { resourceId: facts.sessionId }),
      };
    },

    deliverSessionStream,
    dispatchSessionMessage,
    meshCore: () => wiring()?.meshCore(),
    roomSessionPlace: () => wiring()?.roomSessionPlace(),
    resolveRuntime: (sessionId) => runtimeRegistry.resolveForSession(sessionId),
    clearQueuedMessages,

    recordAudit: (input) => {
      recordAudit(input);
    },
    owner: relayOwnerActor,

    approvalKeys: () => readApprovalKeys(),
    approvalPin: () => {
      const pin = readRelayPin();
      return pin
        ? { computerId: pin.computerId, computerName: pin.computerName, hubOrigin: pin.hubOrigin }
        : null;
    },
    pendingApproval: (sessionId, toolCallId): PendingApprovalCard | null => {
      const card = peekProjector(sessionId)
        ?.getPendingInteractions()
        .find((pending) => pending.type === 'approval' && pending.id === toolCallId);
      if (card?.type !== 'approval') return null;
      return {
        toolName: card.toolName,
        input: card.input,
        ...(card.displayName !== undefined ? { displayName: card.displayName } : {}),
        ...(card.blockedPath !== undefined ? { blockedPath: card.blockedPath } : {}),
      };
    },
    approvableCard: (card, cwd) => relayApprovableCard(card, { cwd, dorkHome: resolveDorkHome() }),
    approveTool: async (sessionId, toolCallId, approved, options) =>
      (await runtimeRegistry.resolveForSession(sessionId)).approveTool(
        sessionId,
        toolCallId,
        approved,
        options
      ),
    bumpSignCount: (credentialId, expected, signCount) =>
      bumpSignCount(credentialId, expected, signCount),
  };
}
