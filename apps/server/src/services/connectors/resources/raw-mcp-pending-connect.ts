/** Private canonical-row admission for preconfigured raw MCP authentication probes. */
import {
  and,
  connectorAuthenticationFlows,
  connectorProviderInstances,
  eq,
  type Db,
} from '@dorkos/db';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import { connectorAuthenticationRequestHash } from './authentication-flow-request.js';
import type { ConnectorRegistry } from '../registry.js';
import type { RawMcpPendingConnectResolver } from '../providers/raw-mcp.js';

/** Bind every lookup to the server's current configured owner and exact registered instance. */
export function createRawMcpPendingConnectResolver(options: {
  db: Db;
  registry: ConnectorRegistry;
  owner: ConnectorOwnerAuthority;
  now?: () => Date;
}): RawMcpPendingConnectResolver {
  const { db, registry, owner } = options;
  const ownerKind = owner.kind;
  const ownerId = owner.kind === 'user' ? owner.userId : owner.installationId;
  return (provider, providerFlowId) => {
    // Query the selector before narrowing authority: a duplicated handle is
    // ambiguous even if only one row would match this owner or generation.
    const rows = db
      .select()
      .from(connectorAuthenticationFlows)
      .where(eq(connectorAuthenticationFlows.providerFlowId, providerFlowId))
      .limit(2)
      .all();
    if (rows.length !== 1) return undefined;
    const row = rows[0]!;
    if (
      row.state !== 'pending' ||
      row.ownerKind !== ownerKind ||
      row.ownerId !== ownerId ||
      row.providerInstanceId !== provider.instanceId ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) <= (options.now?.() ?? new Date()).getTime() ||
      registry.providerExecutionConfigGeneration(provider) !== row.executionConfigGeneration ||
      provider.getCapabilities().capabilities.authentication.status !== 'available'
    )
      return undefined;
    const instance = db
      .select()
      .from(connectorProviderInstances)
      .where(
        and(
          eq(connectorProviderInstances.id, provider.instanceId),
          eq(connectorProviderInstances.type, 'mcp'),
          eq(connectorProviderInstances.ownerKind, ownerKind),
          eq(connectorProviderInstances.ownerId, ownerId),
          eq(connectorProviderInstances.status, 'available'),
          eq(connectorProviderInstances.executionConfigGeneration, row.executionConfigGeneration)
        )
      )
      .get();
    if (
      !instance ||
      row.requestHash !==
        connectorAuthenticationRequestHash({
          providerInstanceId: row.providerInstanceId,
          toolkit: row.toolkit,
          ...(row.label !== null && { label: row.label }),
          ...(row.reconnectConnectionId !== null && {
            reconnectConnectionId: row.reconnectConnectionId,
          }),
        })
    )
      return undefined;
    return {
      authenticationFlowId: row.id,
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
      providerInstanceId: row.providerInstanceId,
      executionConfigGeneration: row.executionConfigGeneration,
      providerFlowId,
      toolkit: row.toolkit,
      label: row.label,
      requestHash: row.requestHash,
      expiresAt: row.expiresAt,
      reconnectConnectionId: row.reconnectConnectionId,
    };
  };
}
