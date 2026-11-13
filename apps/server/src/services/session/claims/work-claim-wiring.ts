/**
 * Boot wiring for work claims (DOR-4019): the service, the tools' deps, and the
 * two lifecycle hooks that keep claims honest. A chat seen working keeps its
 * claims alive, and a chat that settles on a new id takes its claims with it.
 *
 * @module services/session/claims/work-claim-wiring
 */
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { chatMarkdownLink } from '@dorkos/shared/session-link';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import type { CapabilityDeps } from '../../core/capabilities/index.js';
import { chatTitleOf, maySeeChat } from '../chat-messages/chat-message-wiring.js';
import { onProjectorStatusChange } from '../session-state-projector.js';
import { getWorkClaims, setWorkClaims } from './work-claim-current.js';
import { WorkClaimService } from './work-claim-service.js';

/** What {@link wireWorkClaims} hands back. */
export interface WorkClaimWiring {
  /** The service. */
  service: WorkClaimService;
  /** What the claim tools need. */
  capabilityDeps: NonNullable<CapabilityDeps['workClaimDeps']>;
  /** Stop listening to session lifecycle. */
  stop(): void;
}

/**
 * Build the claim service and hook it to session lifecycle.
 *
 * @param deps - The database and Mesh, read at call time.
 */
export function wireWorkClaims(deps: {
  db: Db;
  meshCore: () => MeshCore | undefined;
}): WorkClaimWiring {
  const service = new WorkClaimService({ db: deps.db });
  setWorkClaims(service);
  const unsubscribe = onProjectorStatusChange((update) => {
    if (update.retiredSessionId) service.rekey(update.retiredSessionId, update.sessionId);
    service.touch(update.sessionId);
  });
  return {
    service,
    capabilityDeps: {
      service,
      agentIdForPath: (agentPath) => deps.meshCore()?.getByPath(agentPath)?.id,
      // The reader rule decides what the asking chat may learn of the holder: a
      // chat it may not read is named only as private (DOR-3133 Security Must 2).
      describeChat: async (caller, sessionId) => {
        if (!maySeeChat(caller, sessionId)) return { title: null, link: null, private: true };
        const raw = await chatTitleOf(sessionId);
        const title = raw ? (sanitizeIdentity(raw) ?? null) : null;
        return { title, link: chatMarkdownLink(sessionId, title), private: false };
      },
    },
    stop: () => {
      unsubscribe();
      if (getWorkClaims() === service) setWorkClaims(undefined);
    },
  };
}
