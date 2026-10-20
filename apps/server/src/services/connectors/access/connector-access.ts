/**
 * Who can use a connected app: the three services that keep it, built
 * together because each leans on the one before (moved out of `index.ts`).
 *
 * - {@link ConnectorReconciliationService} reads an app's actions and records
 *   who may use which, for a named agent or every agent.
 * - {@link LevelFollower} keeps every level ("Read", "Read and write") following
 *   its app's actions (ADR 260929-071355): each leveled app is read at least
 *   every 12 hours while the server runs, and right after an update, which may
 *   classify actions differently.
 * - {@link TrustedConnectionSharing} shares a connected app with every agent on
 *   a Trusted install (spec `trusted-by-default-flip` §5.6).
 *
 * @module services/connectors/access/connector-access
 */
import { SERVER_VERSION } from '../../../lib/version.js';
import type { ConfigManager } from '../../core/config-manager.js';
import {
  ConnectorReconciliationService,
  type ConnectorReconciliationServiceOptions,
} from '../reconciliation-service.js';
import { LevelFollower } from '../resources/level-follower.js';
import { TrustedConnectionSharing } from './trusted-sharing.js';

/** What {@link createConnectorAccess} needs from the server. */
export interface ConnectorAccessDeps extends Pick<
  ConnectorReconciliationServiceOptions,
  'db' | 'registry' | 'bootEpoch' | 'managedAuthority' | 'activity'
> {
  /** The agents registered now; read when a review is made. */
  readonly agents: () => ReadonlyArray<{ id: string; name: string; displayName?: string }>;
  /** Live config: login decides how a change's author is named; `permissions` holds the posture. */
  readonly config: Pick<ConfigManager, 'get' | 'set'>;
}

/** The services {@link createConnectorAccess} builds. */
export interface ConnectorAccess {
  /** Reviews and applies who can use each app. */
  readonly reconciliation: ConnectorReconciliationService;
  /** Keeps levels following their apps; started by the caller. */
  readonly levels: LevelFollower;
  /** Shares connected apps with every agent on a Trusted install. */
  readonly sharing: TrustedConnectionSharing;
}

/**
 * Build the services that decide who can use a connected app.
 *
 * @param deps - The connector database, registry, agents, Activity and config.
 */
export function createConnectorAccess(deps: ConnectorAccessDeps): ConnectorAccess {
  const reconciliation = new ConnectorReconciliationService({
    db: deps.db,
    registry: deps.registry,
    bootEpoch: deps.bootEpoch,
    listAgents: () =>
      deps.agents().map((agent) => ({
        agentId: agent.id,
        displayName: agent.displayName ?? agent.name,
      })),
    managedAuthority: deps.managedAuthority,
    activity: deps.activity,
    // With login off DorkOS cannot tell the app from a program on this
    // computer, so the trail says exactly that rather than "You".
    writer: () =>
      deps.config.get('auth')?.enabled === true
        ? { actorType: 'user', actorLabel: 'Your signed-in account' }
        : { actorType: 'user', actorLabel: 'Someone on this computer' },
  });
  return {
    reconciliation,
    levels: new LevelFollower({ reconciliation, appVersion: SERVER_VERSION }),
    sharing: new TrustedConnectionSharing({
      db: deps.db,
      config: deps.config,
      reconciliation,
      managedAuthority: deps.managedAuthority,
    }),
  };
}
