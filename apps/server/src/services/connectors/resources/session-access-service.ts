/**
 * The owner's per-chat app switch (DOR-2448): turn one app on or off for one
 * chat's agent.
 *
 * The switch is exactly reversible and never widens a chat:
 *
 * - **Off** writes a `'detached'` session override, hiding the app from the
 *   agent in this chat alone. The chat's own hand-picked grants (session
 *   grants) stay where they are, so turning it on can put them back.
 * - **On** only undoes an off. When the chat still has its own grants for its
 *   current agent, it writes `'attached'` again, so the chat keeps exactly the
 *   access the owner picked for it, and the agent's wider account-wide grants
 *   still don't count here (`agent-grant-scope.ts`). Otherwise it removes the
 *   override, and the chat goes back to the agent's account-wide access.
 * - Either direction is a no-op when the chat is already that way.
 *
 * Whether a connection can be switched at all, and whether it is on or off
 * now, is read from the same owner projection the chat renders
 * ({@link ConnectorOperatorQueryService.sessionConnections}), so the control
 * and its guard can never disagree.
 *
 * Owner-only: it is reached solely through the owner Connections boundary and
 * no agent tool calls it.
 *
 * @module services/connectors/resources/session-access-service
 */
import { and, connectionOperationGrants, eq, isNull, type Db } from '@dorkos/db';
import {
  ConnectorSessionAccessUpdateSchema,
  type ConnectorSessionAccessUpdate,
  type ConnectorSessionConnections,
} from '@dorkos/shared/connector-resource-schemas';
import { ConnectionIdSchema, type ConnectionId } from '@dorkos/shared/connector-schemas';
import type { SessionConnectorAttachmentStore } from '../attachment-store.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import {
  ConnectorOperatorQueryError,
  type ConnectorOperatorQueryService,
} from './operator-query-service.js';

/** Construction dependencies for {@link ConnectorSessionAccessService}. */
export interface ConnectorSessionAccessServiceOptions {
  /** Canonical connector database, read for the chat's own grants. */
  readonly db: Db;
  /** The owner's view of one chat's access; also resolves the chat's agent. */
  readonly query: Pick<ConnectorOperatorQueryService, 'sessionConnections'>;
  /** Where one chat's per-app overrides are kept. */
  readonly overrides: Pick<SessionConnectorAttachmentStore, 'setState' | 'clearState'>;
}

/** Owner writes for one chat's per-app switch — see module doc. */
export class ConnectorSessionAccessService {
  /** Construct the per-chat switch over the owner session projection. */
  constructor(private readonly options: ConnectorSessionAccessServiceOptions) {}

  /**
   * Turn one app on or off for one chat's agent, then return the chat's
   * access as it now stands.
   *
   * A chat handed to another agent can hold that agent's override, which
   * denies the current agent. Turning the app on replaces it: the result is
   * only the current agent's access (this chat's own grants for the current
   * agent, else its account-wide access). The earlier agent's chat grants are
   * never carried over, because they are read for the current agent only.
   *
   * @param owner - The verified owner making the change.
   * @param sessionId - The chat whose access changes.
   * @param connectionId - The connected account to switch.
   * @param update - `{ on: false }` hides the app here; `{ on: true }` undoes that.
   * @throws {@link ConnectorOperatorQueryError} `session_not_found` for an unknown or foreign chat, and
   *   `connection_not_found` when the agent was not given this account account-wide, so there is nothing to switch.
   */
  async setAccess(
    owner: ConnectorOwnerAuthority,
    sessionId: string,
    connectionId: string,
    update: ConnectorSessionAccessUpdate
  ): Promise<ConnectorSessionConnections> {
    const parsedId = ConnectionIdSchema.parse(connectionId);
    const { on } = ConnectorSessionAccessUpdateSchema.parse(update);
    const current = await this.options.query.sessionConnections(owner, sessionId);
    const row = current.connections.find((connection) => connection.connectionId === parsedId);
    if (!row?.thisChat) {
      throw new ConnectorOperatorQueryError(
        'connection_not_found',
        'This chat’s agent wasn’t given that app, so there’s nothing to turn on or off here.'
      );
    }
    if ((row.thisChat === 'on') === on) return current;
    if (!on) {
      this.options.overrides.setState(sessionId, parsedId, 'detached', current.agentId);
    } else if (this.chatHasOwnGrants(sessionId, current.agentId, parsedId)) {
      this.options.overrides.setState(sessionId, parsedId, 'attached', current.agentId);
    } else {
      this.options.overrides.clearState(sessionId, parsedId);
    }
    return this.options.query.sessionConnections(owner, sessionId);
  }

  /** Whether this chat still has live grants of its own for its current agent. */
  private chatHasOwnGrants(sessionId: string, agentId: string, connectionId: ConnectionId) {
    return (
      this.options.db
        .select({ id: connectionOperationGrants.id })
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.subjectType, 'session'),
            eq(connectionOperationGrants.subjectId, sessionId),
            eq(connectionOperationGrants.agentId, agentId),
            eq(connectionOperationGrants.connectionId, connectionId),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .get() !== undefined
    );
  }
}
