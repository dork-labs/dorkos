/**
 * The owner's per-chat app switch (DOR-2448): turn one app on or off for one
 * chat's agent.
 *
 * The switch only ever narrows or restores what the agent was given
 * account-wide. Off writes a `'detached'` session override, which hides the
 * app from the agent in this chat alone. On removes the override, so the chat
 * goes back to exactly the agent's account-wide access, never more. Whether a
 * connection can be switched at all is read from the same owner projection the
 * chat renders ({@link ConnectorOperatorQueryService.sessionConnections}), so
 * the control and its guard can never disagree.
 *
 * Owner-only: it is reached solely through the owner Connections boundary and
 * no agent tool calls it.
 *
 * @module services/connectors/resources/session-access-service
 */
import {
  ConnectorSessionAccessUpdateSchema,
  type ConnectorSessionAccessUpdate,
  type ConnectorSessionConnections,
} from '@dorkos/shared/connector-resource-schemas';
import { ConnectionIdSchema } from '@dorkos/shared/connector-schemas';
import type { SessionConnectorAttachmentStore } from '../attachment-store.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import {
  ConnectorOperatorQueryError,
  type ConnectorOperatorQueryService,
} from './operator-query-service.js';

/** Construction dependencies for {@link ConnectorSessionAccessService}. */
export interface ConnectorSessionAccessServiceOptions {
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
   * @param owner - The verified owner making the change.
   * @param sessionId - The chat whose access changes.
   * @param connectionId - The connected account to switch.
   * @param update - `{ on: true }` restores the agent's account-wide access here; `{ on: false }` hides it here.
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
    if (on) this.options.overrides.clearState(sessionId, parsedId);
    else this.options.overrides.setState(sessionId, parsedId, 'detached', current.agentId);
    return this.options.query.sessionConnections(owner, sessionId);
  }
}
