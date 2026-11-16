/**
 * The wakers-off reader over the live server (DOR-3641): which switch decides
 * that heartbeats are off, who a waker waits on, and where that person's name
 * comes from. Kept out of `heartbeats-wiring.ts` so a test can drive it.
 *
 * @module services/heartbeats/wakers-off/live-wakers-off
 */
import type { Db } from '@dorkos/db';
import type { WakersOffRouterDeps } from '../../../routes/wakers-off.js';
import { auditTrail } from '../../audit/audit-trail.js';
import { configManager } from '../../core/config-manager.js';
import { agentPause } from '../../mesh/pause/index.js';
import type { BeatAgent } from '../beat-runner.js';
import type { HeartbeatStore } from '../heartbeat-store.js';
import type { ReportsToChain } from '../reports-to.js';
import { wakersOffReader } from './wakers-off.js';

/** What the live reader needs from heartbeats' own startup. */
export interface LiveWakersOffDeps {
  /** The server database. */
  db: Db;
  /** Every agent on this server. */
  agents: { list(): BeatAgent[] };
  /** The heartbeat state. */
  store: Pick<HeartbeatStore, 'getState'>;
  /** Who each agent reports up to. */
  chain: Pick<ReportsToChain, 'resolveChainPerson'>;
  /** The owner's account id. */
  ownerAccountId(): string;
  /** Whether an account id is the owner's. */
  isOwner(accountId: string): boolean;
}

/**
 * Build the route's reader over the live server.
 *
 * - **Heartbeats are off** only when the person's own switch says so. On an
 *   agent computer the hub drives beats (DOR-2940), which is not "off".
 * - **A global schedule** waits on the owner.
 * - **The owner's name** is their profile name, else their account's; nobody
 *   else's name is known here.
 *
 * @param deps - What heartbeats' startup hands over.
 */
export function liveWakersOffReader(deps: LiveWakersOffDeps): WakersOffRouterDeps {
  return wakersOffReader({
    db: deps.db,
    agents: deps.agents,
    enabled: () => configManager.get('heartbeats').enabled,
    store: deps.store,
    pauses: () => agentPause()?.list() ?? [],
    personOf: (agentId) =>
      agentId ? deps.chain.resolveChainPerson(agentId).accountId : deps.ownerAccountId(),
    nameOf: (accountId) =>
      deps.isOwner(accountId)
        ? (configManager.get('profile').displayName ?? auditTrail()?.accounts.owner().name ?? null)
        : null,
  });
}
