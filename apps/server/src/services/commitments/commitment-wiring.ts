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
import { TodoTurns } from './todo-turns.js';
import { todoTurnSeams } from './todo-turn-wiring.js';
import { logger } from '../../lib/logger.js';

/** How often queued to-do turns are checked for a new day. */
const TODO_QUEUE_DRAIN_MS = 60 * 60 * 1000;

/** What the wiring needs from boot. */
export interface CommitmentWiringDeps {
  /** The DorkOS database. */
  db: Db;
  /** The agent registry, read lazily: Mesh starts later in boot, or not at all. */
  meshCore: () => Pick<MeshCore, 'get' | 'getByPath' | 'getProjectPath'> | undefined;
}

/** The running commitments domain, as boot holds it. */
export interface CommitmentWiring {
  /** Records, reads and watches commitments; `observe()` is the heartbeat seam. */
  service: CommitmentService;
  /** Makes and changes to-dos on the same table (DOR-3088). */
  todos: TodoService;
  /** Starts, queues and holds the turns to-dos ask for. */
  todoTurns: TodoTurns;
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
  const todoStore = new TodoStore(deps.db);
  const todoTurns = new TodoTurns({ db: deps.db, ...todoTurnSeams(deps) });
  const todos = new TodoService({
    store: todoStore,
    agentExists,
    // One install is one space until spaces ship: two agents share it when both are on this
    // computer's team, read from Mesh, never from the caller.
    mayAssign: (from, to) => agentExists(from) && agentExists(to),
    rearm: (id) => service.track(id),
    onTurnable: (row, chargedTo) => {
      void todoTurns.request(row, chargedTo).catch((err: unknown) =>
        logger.warn('[todos] a to-do turn request failed', {
          todoId: row.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    },
  });
  // Turns queued past a charge's daily cap start the next UTC day, and turns a passing refusal
  // held retry; checked hourly. Never at boot: Mesh and the rooms are not up yet then, and a
  // launch there would only fail.
  const drain = () =>
    void todoTurns
      .drainQueued((id) => todoStore.get(id))
      .catch((err: unknown) =>
        logger.warn('[todos] queued to-do turns did not drain', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
  const drainTimer = setInterval(drain, TODO_QUEUE_DRAIN_MS);
  drainTimer.unref?.();
  return {
    service,
    todos,
    todoTurns,
    capabilityDeps: { service, agentIdForPath },
    routeDeps: routerDeps,
    stop: () => {
      clearInterval(drainTimer);
      service.stop();
    },
  };
}
