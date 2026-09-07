/** Program-authenticated receive-grant visibility using the existing subscription store. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  ConnectorAgentEventSubscriptionPageSchema,
  ConnectorAgentEventSubscriptionQuerySchema,
  type ConnectorAgentEventSubscriptionPage,
} from '@dorkos/shared/connector-event-schemas';
import type { ConnectorAgentOwnershipPort } from '../execution/authorization-service.js';
import type { ConnectorProgramPrincipalService } from '../principal/program-principal-service.js';
import type { ServerPrincipalProof } from '../principal/server-principal.js';
import type { ConnectorSubscriptionStore } from './subscription-store.js';
import type { ManagedEventConsentAuthority } from './grant-port.js';

const CursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    after: z.string().min(1).max(256),
  })
  .strict();

/** Safe read refusal; the program never gains owner management authority. */
export class ConnectorEventAccessError extends Error {
  constructor(readonly code: 'credential_unavailable' | 'agent_not_owned' | 'invalid_cursor') {
    super(
      code === 'credential_unavailable'
        ? 'Your API key is no longer available.'
        : code === 'agent_not_owned'
          ? 'The selected agent was not found.'
          : 'This notification cursor does not belong to the selected agent.'
    );
    this.name = 'ConnectorEventAccessError';
  }
}

/** No operation grants are required or consulted for independent receive permission. */
export class ConnectorEventAccessQueryService {
  constructor(
    private readonly store: ConnectorSubscriptionStore,
    private readonly ownership: ConnectorAgentOwnershipPort,
    private readonly programs: Pick<ConnectorProgramPrincipalService, 'revalidate'>,
    private readonly managed: Pick<ManagedEventConsentAuthority, 'ready'>
  ) {}

  /** Return only the current canonical agent's approved receive scopes and safe account labels. */
  async listSubscriptions(
    principal: ServerPrincipalProof,
    input: unknown
  ): Promise<ConnectorAgentEventSubscriptionPage> {
    const query = ConnectorAgentEventSubscriptionQuerySchema.parse(input);
    this.requireCredential(principal);
    const owner = principal.claims.owner;
    if (!(await this.ownership.ownsAgent(owner, query.agentId)))
      throw new ConnectorEventAccessError('agent_not_owned');
    // The ownership resolver may await the agent registry. Never read through a
    // key that was disabled, replaced or reassigned while that lookup ran.
    this.requireCredential(principal);
    const ownerId = owner.kind === 'user' ? owner.userId : owner.installationId;
    const scope = createHash('sha256')
      .update(stableStringify({ owner, agentId: query.agentId }))
      .digest('hex');
    let after = '';
    if (query.cursor) {
      try {
        const raw = Buffer.from(query.cursor, 'base64url');
        if (raw.toString('base64url') !== query.cursor) throw new Error();
        const cursor = CursorSchema.parse(JSON.parse(raw.toString('utf8')));
        if (cursor.scope !== scope) throw new Error();
        after = cursor.after;
      } catch {
        throw new ConnectorEventAccessError('invalid_cursor');
      }
    }
    const limit = query.limit ?? 50;
    return this.store.db.transaction(() => {
      this.requireCredential(principal);
      const rows = this.store.db.$client
        .prepare(
          `SELECT s.id, s.connection_id, c.toolkit, c.label, p.mode FROM connector_event_subscriptions s
        JOIN connections c ON c.id = s.connection_id JOIN connector_provider_instances p ON p.id = c.provider_instance_id
        JOIN connector_event_definitions d ON d.id = s.definition_id JOIN connector_event_bindings b ON b.id = s.binding_id
        WHERE p.owner_kind = ? AND p.owner_id = ? AND s.agent_id = ? AND s.revoked_at IS NULL AND s.enabled = 1
          AND d.current = 1 AND d.provider_instance_id = p.id AND d.toolkit = c.toolkit
          AND b.provider_instance_id = p.id AND b.definition_id = d.id AND b.external_account_ref = c.external_account_ref
          AND b.provider_generation = p.execution_config_generation AND s.id > ?
        ORDER BY s.id LIMIT ?`
        )
        .all(owner.kind, ownerId, query.agentId, after, limit + 1) as Array<{
        id: string;
        connection_id: string;
        toolkit: string;
        label: string;
        mode: string;
      }>;
      const page = rows.slice(0, limit);
      return ConnectorAgentEventSubscriptionPageSchema.parse({
        agentId: query.agentId,
        subscriptions: page.map((row) => {
          const subscription = this.store.get(owner, row.connection_id, row.id);
          const active =
            subscription.state === 'active' &&
            (row.mode !== 'managed' ||
              this.managed.ready(subscription.id, subscription.scopeVersion));
          return {
            ...subscription,
            toolkit: row.toolkit,
            label: row.label,
            state: active ? 'active' : 'unavailable',
          };
        }),
        ...(rows.length > limit
          ? {
              nextCursor: Buffer.from(
                JSON.stringify({ version: 1, scope, after: page.at(-1)!.id })
              ).toString('base64url'),
            }
          : {}),
      });
    });
  }

  private requireCredential(principal: ServerPrincipalProof): void {
    if (!this.programs.revalidate(principal))
      throw new ConnectorEventAccessError('credential_unavailable');
  }
}
