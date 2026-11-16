/**
 * What the connector execution path reads to apply the monthly spend limit
 * (DOR-4204 PR 2): the meter, and whether the calling turn read outside
 * words. One port for the preflight and the broker, so both decide from the
 * same facts.
 *
 * @module services/connectors/spending/spending-port
 */
import { agents, eq, type Db } from '@dorkos/db';
import { isPaidOperation } from '@dorkos/shared/connector-schemas';
import type { ActivityService } from '../../activity/activity-service.js';
import { chatReadOutsideWords } from '../../core/turn-power/chat-outside-words.js';
import { agentMarksRunning } from '../../core/turn-power/turn-marks.js';
import { nextMonthStart, SpendingStore } from './spending-store.js';
import type { SpendFacts } from './spend-decision.js';

/** The spend limit's view of the world, wired once at startup. */
export interface ConnectorSpendingPort {
  /** The meter, the limit and the prices. */
  readonly store: SpendingStore;
  /**
   * Whether the calling turn read words from outside the team (Security
   * Must 1): such a turn never spends.
   *
   * @param sessionId - The calling session, when the surface verified one.
   * @param agentId - The agent the run is for, by Mesh id.
   */
  readonly outsider: (sessionId: string | undefined, agentId: string) => boolean;
  /** Writes the Activity lines of spec §9; omitted, nothing is recorded. */
  readonly activity?: Pick<ActivityService, 'emit'>;
  /** What to call an agent in those lines, by Mesh id. */
  readonly agentName?: (agentId: string) => string | undefined;
}

/**
 * Read the facts one paid run is decided on. A store that cannot be read is
 * `'unreadable'`, which fails closed into a card (Security Q8).
 *
 * @param port - The wired spend limit.
 * @param op - The operation about to run.
 * @param caller - The calling session, if any, and the agent the run is for.
 * @param now - The decision's instant.
 */
export function spendFactsFor(
  port: ConnectorSpendingPort,
  op: { toolkit: string; operationSlug: string },
  caller: { sessionId?: string; agentId: string },
  now: Date
): SpendFacts {
  const paid = isPaidOperation(op);
  const outsider = paid && port.outsider(caller.sessionId, caller.agentId);
  try {
    const usedMicro = paid ? port.store.meter().usedMicro : 0;
    return {
      paid,
      outsider,
      limitMicro: port.store.limit(),
      priceMicro: port.store.price(op.toolkit),
      usedMicro,
      resetsAt: nextMonthStart(now),
    };
  } catch {
    return {
      paid,
      outsider,
      limitMicro: null,
      priceMicro: null,
      usedMicro: 'unreadable',
      resetsAt: nextMonthStart(now),
    };
  }
}

let active: ConnectorSpendingPort | undefined;

/**
 * Wire the spend limit once at startup, or clear it (tests).
 *
 * @param port - The wired spend limit, or `undefined` to clear it.
 */
export function initConnectorSpending(port: ConnectorSpendingPort | undefined): void {
  active = port;
}

/** The wired spend limit, or `undefined` before startup wires it. */
export function connectorSpending(): ConnectorSpendingPort | undefined {
  return active;
}

/**
 * What the team calls an agent, by Mesh id, for the spend limit's Activity lines.
 *
 * @param db - The consolidated database.
 */
export function agentNameIn(db: Db): (agentId: string) => string | undefined {
  return (agentId) => {
    const row = db
      .select({ name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    return row ? row.displayName || row.name : undefined;
  };
}

/**
 * Whether a paid run's turn read outside words (Security Must 1), as memory
 * and the browser read it: the session's own record when one is named. A
 * caller that names none (an agent token over `/mcp`, a program) carries
 * every mark its agent's running turns carry. An agent that can't be found
 * reads as outside: money fails closed.
 *
 * @param db - The consolidated database, to find the agent's home.
 */
export function turnReadOutsideWords(
  db: Db
): (sessionId: string | undefined, agentId: string) => boolean {
  return (sessionId, agentId) => {
    const home = db
      .select({ path: agents.projectPath })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()?.path;
    if (sessionId) return chatReadOutsideWords(sessionId, home);
    return home === undefined || agentMarksRunning(home).outsider === true;
  };
}

/**
 * Make the spend limit's meter and wire it for the gate and the broker, once
 * at startup. An outsider-marked turn never spends.
 *
 * @param db - The consolidated database.
 * @param activity - Where its Activity lines go.
 * @returns The meter, for the routes.
 */
export function wireConnectorSpending(
  db: Db,
  activity: Pick<ActivityService, 'emit'>
): SpendingStore {
  const store = new SpendingStore(db);
  initConnectorSpending({
    store,
    outsider: turnReadOutsideWords(db),
    activity,
    agentName: agentNameIn(db),
  });
  return store;
}
