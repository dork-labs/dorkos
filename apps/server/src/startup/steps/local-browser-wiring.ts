import { createBrowserSharePolicy } from '../../services/session/local-browser/agent-profiles/sharing-policy.js';
import { localBrowserHost } from '../local-browser.js';
import { realpathSync } from 'node:fs';
import { createAgentBrowserProfiles } from '../../services/session/local-browser/agent-profiles/agent-profiles.js';
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import {
  createLocalBrowserProfileAccess,
  createLocalBrowserProfileProof,
  type LocalBrowserProfileAccessDeps,
} from '../../services/session/local-browser/profile-access.js';
import { loadProfileBindingKey } from '../../services/session/local-browser/profile-folders.js';
import { createLocalBrowserProfileStore } from '../../services/session/local-browser/profile-store.js';
import { liveOutsideTurnCheck } from '../../services/session/local-browser/outside-turn.js';
import { agentWindowLabel } from '../../services/session/local-browser/agent-window/index.js';
import { handBackWake } from '../../services/session/local-browser/hand-back-wake/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { notify } from '../../services/notifications/notification-service.js';
import { localBrowserChangedAnnouncer } from '../../services/core/streams/live-change-broadcasts.js';
import { logger } from '../../lib/logger.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import type { ServerRefs } from '../server-refs.js';

/** Wire profile ownership and person-only sharing onto the boot-owned page service. */
export function wireLocalBrowserProfiles(refs: ServerRefs, db: Db, dorkHome: string) {
  const localBrowserService = localBrowserHost.start(dorkHome);
  // Read once and kept in memory, so a key swapped on disk changes nothing until a restart.
  let bindingKey: Buffer | undefined;
  const localBrowserProfiles = createLocalBrowserProfileStore(
    db,
    () => (bindingKey ??= loadProfileBindingKey(dorkHome)),
    (profileId, agentId) => {
      void localBrowserService
        .revokeProfileAccess(profileId, agentId)
        .catch(() => logger.warn('[Browser] A revoked browser page is still closing'));
    }
  );
  const realFolder = (folder: string) => {
    try {
      return realpathSync(folder);
    } catch {
      return undefined;
    }
  };
  const profileAccessDeps: LocalBrowserProfileAccessDeps = {
    profiles: localBrowserProfiles,
    resolveSessionRuntime: (sessionId) => runtimeRegistry.resolveSessionRuntime(sessionId),
    guardsOf: (type) => {
      try {
        return runtimeRegistry.get(type).getCapabilities().guards;
      } catch {
        return undefined; // Not registered, or unreadable: no guards.
      }
    },
    getSessionAgentPath: (sessionId) => runtimeRegistry.getSessionAgentPath(sessionId),
    agentIdAtPath: (agentPath) => refs.meshCore?.getByPath(agentPath)?.id,
    realFolder,
  };
  localBrowserService.useProfileAccess(
    createLocalBrowserProfileAccess(profileAccessDeps),
    (id) => localBrowserProfiles.get(id) !== undefined,
    createLocalBrowserProfileProof({
      profiles: localBrowserProfiles,
      sessionFacts: (sessionId) =>
        db
          .select({ runtime: sessionMetadata.runtime, agentPath: sessionMetadata.agentPath })
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, sessionId))
          .get(),
      guardsOf: (type) => {
        try {
          return runtimeRegistry.get(type).getCapabilities().guards;
        } catch {
          return undefined;
        }
      },
      agentIdAtPath: (agentPath) => refs.meshCore?.getByPath(agentPath)?.id,
      realFolder,
    })
  );
  const selection = createAgentBrowserProfiles({
    ...profileAccessDeps,
    profiles: localBrowserProfiles,
    agentName: (id) => refs.meshCore?.listWithPaths().find((a) => a.id === id)?.name,
  });
  localBrowserService.useProfileSelection(selection.select, selection.initialize);
  localBrowserService.useSessionAgentLookup(async (sessionId) => {
    const agentPath = await runtimeRegistry.getSessionAgentPath(sessionId);
    return agentPath ? refs.meshCore?.getByPath(agentPath)?.id : undefined;
  });
  localBrowserService.windowNames.use(async (sessionId) => {
    const agentPath = await runtimeRegistry.getSessionAgentPath(sessionId);
    const agent = agentPath ? refs.meshCore?.getByPath(agentPath) : undefined;
    return agent ? agentWindowLabel(agent) : undefined;
  });
  localBrowserService.handover.useOutsideTurnCheck(liveOutsideTurnCheck());
  localBrowserService.handover.useAgentIdLookup(
    (agentFolder) => refs.meshCore?.getByPath(agentFolder)?.id
  );
  localBrowserService.handover.useChangeListener(localBrowserChangedAnnouncer(eventFanOut));
  localBrowserService.handover.useHandoffListener((handoff) => {
    void notify('browser.handoff', {
      handoffId: handoff.id,
      sessionId: handoff.sessionId,
      site: handoff.site,
      agentName: handoff.agentName,
      agentId: handoff.agentId,
    });
  });
  localBrowserService.handover.useEndListener(
    handBackWake({
      meshCore: () => refs.meshCore,
      roomSessionPlace: () => refs.roomSessionPlacePort,
    })
  );
  return {
    service: localBrowserService,
    profiles: {
      profiles: localBrowserProfiles,
      mayShare: createBrowserSharePolicy({
        state: (id) => localBrowserService.personState(id),
        agentForSession: async (id) => {
          const folder = await runtimeRegistry.getSessionAgentPath(id);
          return folder ? refs.meshCore?.getByPath(folder)?.id : undefined;
        },
        resolveSessionRuntime: (id) => runtimeRegistry.resolveSessionRuntime(id),
        outsideTurn: liveOutsideTurnCheck(),
        runtime: (type) => runtimeRegistry.get(type),
      }),
      agent: (agentId: string) => {
        const agent = refs.meshCore?.listWithPaths().find((entry) => entry.id === agentId);
        const projectPath = agent && realFolder(agent.projectPath);
        return agent && projectPath ? { name: agent.name, projectPath } : undefined;
      },
    },
  };
}
