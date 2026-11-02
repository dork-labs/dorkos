/**
 * Boot wiring for commitments (spec `heartbeats` §12): the service, its due
 * timers rebuilt from the table, what the HTTP routes read, and the capability deps, so
 * the server's entry file holds one call instead of the whole assembly.
 *
 * @module services/commitments/commitment-wiring
 */
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { refuseUnlessAccountOwner } from '../../lib/caller-authority.js';
import type { CommitmentRouterDeps } from '../../routes/commitments.js';
import type { CapabilityDeps } from '../core/capabilities/index.js';
import { personProof } from './caller.js';
import { CommitmentService } from './commitment-service.js';
import { CommitmentStore } from './commitment-store.js';
import { TodoService } from './todo-service.js';
import { TodoStore } from './todo-store.js';

/** What the wiring needs from boot. */
export interface CommitmentWiringDeps {
  /** The DorkOS database. */
  db: Db;
  /** The agent registry, read lazily: Mesh starts later in boot, or not at all. */
  meshCore: () => Pick<MeshCore, 'get' | 'getByPath'> | undefined;
}

/** The running commitments domain, as boot holds it. */
export interface CommitmentWiring {
  /** Records, reads and watches commitments; `observe()` is the heartbeat seam. */
  service: CommitmentService;
  /** Makes and changes to-dos on the same table (DOR-3088). */
  todos: TodoService;
  /** The `commitments` capability domain's deps. */
  capabilityDeps: NonNullable<CapabilityDeps['commitmentDeps']>;
  /**
   * What the routes read, for boot to hand the Hono `/api` app
   * (`http/hono-api.ts`), which serves `/api/commitments` and
   * `/api/agents/:id/commitments` from it.
   */
  routeDeps: CommitmentRouterDeps;
  /** Disarm every due timer. */
  stop(): void;
}

/**
 * Build the commitments domain and arm its due timers from the table.
 *
 * @param deps - The database and the lazy agent registry.
 */
export function wireCommitments(deps: CommitmentWiringDeps): CommitmentWiring {
  const service = new CommitmentService({ store: new CommitmentStore(deps.db) });
  service.start();
  const agentIdForPath = (agentPath: string) => deps.meshCore()?.getByPath(agentPath)?.id;
  const agentExists = (agentId: string) => deps.meshCore()?.get(agentId) !== undefined;
  const routerDeps: CommitmentRouterDeps = {
    service,
    agentExists,
    agentIdForPath,
    // The same owner bar the account routes use: a person, never an agent,
    // and with login on, the install's owner.
    isOwner: (facts) => refuseUnlessAccountOwner(facts) === undefined,
    // Only the owner's own session cookie mints `person` authority (DOR-3088).
    personProven: personProof,
  };
  const todos = new TodoService({
    store: new TodoStore(deps.db),
    agentExists,
    // One install is one space until spaces ship: two agents share it when both are on this
    // computer's team, read from Mesh, never from the caller.
    mayAssign: (from, to) => agentExists(from) && agentExists(to),
    rearm: (id) => service.track(id),
  });
  return {
    service,
    todos,
    capabilityDeps: { service, agentIdForPath },
    routeDeps: routerDeps,
    stop: () => service.stop(),
  };
}
