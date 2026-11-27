/**
 * The person's switch, per connected app, that lets an agent whose turn read only that app write
 * back to it without asking (DOR-4794). Read it, and turn it on or off.
 *
 * Owner-only: an agent, an approval token or a program is refused by `resolveConnectorOperator`
 * before the store is reached, so no agent can raise its own power here. Turning it on is a raise,
 * so it waits for the owner to confirm it's them (`runFrontDoorWrite`); turning it off only
 * narrows, and answers at once. It is deliberately not a capability, an MCP tool or a management
 * action kind, all of which programs or agents can ask for (`same-source-writes-census.test.ts`).
 *
 * @module routes/connector-writes-back
 */
import { Hono, type Context } from 'hono';
import {
  ConnectorWritesBackChangeRequestSchema,
  ConnectorWritesBackChangeSchema,
  ConnectorWritesBackSchema,
} from '@dorkos/shared/connector-exclusion-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { readActivityActor } from '../services/activity/activity-actor.js';
import {
  WritesBackConnectionNotFoundError,
  WritesBackUnsupportedAppError,
  type WritesBackStore,
} from '../services/connectors/access/writes-back-store.js';
import {
  everyAgentActivityLink,
  serviceName,
  type EveryAgentActivitySink,
} from '../services/connectors/every-agent-activity.js';
import type { ConnectorOwnerAuthority } from '../services/core/connections-lease/index.js';
import {
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';
import { CONNECTED_APPS } from './connector-step-up.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** Event type for writes back turned on or off for one connected app. */
export const WRITES_BACK_CHANGED_EVENT = 'connectors.writes_back_changed';

/** What the writes-back routes read. */
export interface ConnectorWritesBackRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** The person's writes-back switch. */
  readonly store: WritesBackStore;
  /** The Activity trail; absent in a process that has none. */
  readonly activity?: EveryAgentActivitySink;
  /** Injectable clock. */
  readonly now?: () => Date;
}

/**
 * Build the writes-back routes, for mounting under `/api/connectors`.
 *
 * @param deps - The owner boundary, the switch's store and the Activity trail.
 * @returns The routes.
 */
export function createConnectorWritesBackRoutes(deps: ConnectorWritesBackRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/connections/:connectionId/writes-back', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    try {
      return c.json(
        ConnectorWritesBackSchema.parse(
          deps.store.readWritesBack(owner, c.req.param('connectionId'))
        )
      );
    } catch (error) {
      return notFoundOr(c, error);
    }
  });

  router.put('/connections/:connectionId/writes-back', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const input = ConnectorWritesBackChangeRequestSchema.safeParse(readJsonBody(c));
    if (!input.success) return validationProblem(c, input.error);
    const connectionId = c.req.param('connectionId');
    const on = input.data.writesBackUnasked;
    // Turning it off only takes power away, so it answers at once.
    if (!on) return change(c, owner, connectionId, false);
    // An app whose writes can be sends is refused before anyone is asked to confirm (DOR-4794).
    try {
      if (!deps.store.readWritesBack(owner, connectionId).supported) {
        return notFoundOr(c, new WritesBackUnsupportedAppError());
      }
    } catch (error) {
      return notFoundOr(c, error);
    }
    return runFrontDoorWrite(c, {
      kind: 'connection.grant',
      target: connectionId,
      input: { op: 'writes-back-unasked', connectionId, on: true },
      reason: 'Let an agent that only read this app write back to it without asking.',
      subject: CONNECTED_APPS,
      run: async () => change(c, owner, connectionId, true),
    });
  });

  /** Make the change, write its Activity line, and answer with what it did. */
  async function change(
    c: Context<ApiEnv>,
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    on: boolean
  ): Promise<Response> {
    try {
      const { change: done, connection } = deps.store.setWritesBack(
        owner,
        connectionId,
        on,
        (deps.now ?? (() => new Date()))()
      );
      if (done.changed && deps.activity) {
        const app = `${serviceName(connection.toolkit)} (${connection.label})`;
        await deps.activity.emit({
          ...readActivityActor(honoRequestFacts(c)),
          category: 'permissions',
          eventType: WRITES_BACK_CHANGED_EVENT,
          resourceType: 'connection',
          resourceId: connection.id,
          resourceLabel: app,
          summary: on
            ? `Let agents that only read ${app} write back to it without asking`
            : `Agents ask again before writing back to ${app}`,
          linkPath: everyAgentActivityLink(connection.id),
          metadata: { connectionId: connection.id, writesBackUnasked: on },
        });
      }
      return c.json(ConnectorWritesBackChangeSchema.parse(done));
    } catch (error) {
      return notFoundOr(c, error);
    }
  }

  return router;
}

/**
 * A missing or someone else's connection answers `404 not_found`, an app the
 * switch isn't offered for `422 app_not_supported`; anything else is thrown on.
 */
function notFoundOr(c: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof WritesBackConnectionNotFoundError) {
    return problem(c, 'not_found', {
      detail: 'That app isn’t connected anymore. Pick it again from the list.',
    });
  }
  if (error instanceof WritesBackUnsupportedAppError) {
    return problem(c, 'app_not_supported', {
      detail: 'Agents always ask before writing to this app. Its changes reach other people.',
    });
  }
  throw error;
}
