/** Live, provider-neutral authorization for one exact connector execution. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  sessionConnectionOverrides,
  and,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  ConnectorOperationRevisionSchema,
  type ConnectorExecutionTarget,
  type ConnectorOperationClassification,
  type ConnectorOperationRevision,
} from '@dorkos/shared/connector-schemas';
import type {
  ConnectorExternalAccountRef,
  ConnectorProvider,
} from '@dorkos/shared/connector-provider';
import type { CapabilityPreflightResult } from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import type { ConnectorRegistry } from '../registry.js';
import {
  createCapabilityAuthorityBinding,
  type CapabilityAuthorityBindingProof,
} from '../principal/capability-authority-binding.js';
import {
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalProof,
} from '../principal/server-principal.js';
import type { ConnectorRuntimeExecutionCapabilityId } from '../runtime-capability-scope.js';

const CLASSIFICATION_BY_CAPABILITY = {
  'connectors.execute_read': 'read',
  'connectors.execute_write': 'write',
  'connectors.execute_destructive': 'destructive',
} as const satisfies Record<
  ConnectorRuntimeExecutionCapabilityId,
  ConnectorOperationClassification
>;

/** Verified agent ownership used only by program and operator surfaces. */
export interface ConnectorAgentOwnershipPort {
  /** Return whether an owner may deliberately act through one stable agent. */
  ownsAgent(owner: ConnectorOwnerAuthority, agentId: string): boolean | Promise<boolean>;
}

/** Input to the live authorization decision. */
export interface PrepareConnectorExecutionInput {
  /** Exact classification capability being invoked. */
  readonly capabilityId: ConnectorRuntimeExecutionCapabilityId;
  /** Public target after its surface schema has parsed it. */
  readonly target: ConnectorExecutionTarget;
  /** Authenticated server principal from the calling boundary. */
  readonly principal: ServerPrincipalProof;
  /** Named agent selected by a program/operator surface; runtime callers cannot supply one. */
  readonly requestedAgentId?: string;
}

/** Private execution material returned only after all live checks pass. */
export interface AuthorizedConnectorExecution {
  /** Authenticated binding consumed by the generic capability tier gate. */
  readonly authorityBinding: CapabilityAuthorityBindingProof;
  /** Exact connection owner. */
  readonly owner: ConnectorOwnerAuthority;
  /** Verified actor category retained by immutable usage evidence. */
  readonly actorKind: 'operator' | 'agent' | 'program' | 'runtime';
  /** Stable actor identifier retained by immutable usage evidence. */
  readonly actorId: string;
  /** Stable agent whose exact grant was checked. */
  readonly agentId: string;
  /** Canonical session whose authority was checked, when present. */
  readonly sessionId?: string;
  /** Exact live provider. */
  readonly provider: ConnectorProvider;
  /** Private provider account binding. */
  readonly externalAccountRef: ConnectorExternalAccountRef;
  /** Immutable operation revision selected by the grant. */
  readonly operation: ConnectorOperationRevision;
  /** Arguments validated against the immutable provider schema. */
  readonly arguments: Record<string, unknown>;
  /** Stable configured provider generation rechecked on every attempt. */
  readonly executionConfigGeneration: number;
  /** Usage payer derived from server-owned provider configuration. */
  readonly payer: 'operator_byo' | 'dorkos_managed';
}

interface ExecutionRow {
  connectionId: string;
  externalAccountRef: string;
  toolkit: string;
  connectionStatus: 'active' | 'expired' | 'revoked' | 'pending';
  lifecycleState: 'connected' | 'disconnected';
  enabled: boolean;
  reconciliationStatus: 'ready' | 'migration_needs_reconcile';
  providerInstanceId: string;
  providerType: string;
  providerMode: 'managed' | 'byo';
  providerStatus: 'available' | 'unavailable' | 'migration_failed';
  executionConfigDigest: string | null;
  executionConfigGeneration: number;
  ownerKind: 'user' | 'local_install' | null;
  ownerId: string | null;
  operationRevisionId: string;
  operationToolkit: string;
  operationSlug: string;
  toolkitVersion: string;
  schemaHash: string;
  classification: ConnectorOperationClassification;
  retryPolicy: 'never' | 'provider_idempotency_key';
  inputSchemaJson: string;
  discoveredAt: string;
}

interface ResolvedExecutionActor {
  readonly actorKind: AuthorizedConnectorExecution['actorKind'];
  readonly actorId: string;
  readonly agentId: string;
  readonly sessionId?: string;
}

function refuse(code: string, message: string): never {
  throw new CapabilityToolError({ error: message, code });
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function isPlainJson(value: unknown): boolean {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isPlainJson);
}

function authorityDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** SQLite-backed live connector authorization. */
export class ConnectorExecutionAuthorizationService {
  private readonly preparedExecutions = new WeakSet<object>();

  /** Construct the authorization service over canonical stores and live providers. */
  constructor(
    private readonly db: Db,
    private readonly registry: ConnectorRegistry,
    private readonly agentOwnership: ConnectorAgentOwnershipPort
  ) {}

  /** Produce the authenticated preflight result consumed by the registry tier gate. */
  async preflight(input: PrepareConnectorExecutionInput): Promise<CapabilityPreflightResult> {
    const authorized = await this.prepare(input);
    return { authorityBinding: authorized.authorityBinding };
  }

  /** Resolve the immutable capability id for a program target without accepting a caller override. */
  capabilityIdForTarget(
    principal: ServerPrincipalProof,
    target: ConnectorExecutionTarget
  ): ConnectorRuntimeExecutionCapabilityId {
    this.registry.assertAvailable();
    if (!isServerPrincipal(principal)) {
      return refuse(
        'CONNECTOR_PRINCIPAL_REQUIRED',
        'Connector execution requires a verified caller.'
      );
    }
    const owner = ownerColumns(principal.claims.owner);
    const row = this.db
      .select({
        connectionToolkit: connections.toolkit,
        operationToolkit: connectorOperationRevisions.toolkit,
        classification: connectorOperationRevisions.capabilityClassification,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .innerJoin(
        connectorOperationRevisions,
        and(
          eq(connectorOperationRevisions.id, target.operationRevisionId),
          eq(connectorOperationRevisions.providerInstanceId, connections.providerInstanceId)
        )
      )
      .where(eq(connections.id, target.connectionId))
      .get();
    if (
      !row ||
      row.ownerKind !== owner.ownerKind ||
      row.ownerId !== owner.ownerId ||
      row.connectionToolkit !== row.operationToolkit
    ) {
      return refuse(
        'CONNECTOR_TARGET_NOT_FOUND',
        'The selected connection or operation was not found.'
      );
    }
    return `connectors.execute_${row.classification}`;
  }

  /** Refuse private discovery and execution while canonical migration is unavailable. */
  assertAvailable(): void {
    this.registry.assertAvailable();
  }

  /** Recheck every live authority fact and return private dispatch material. */
  async prepare(input: PrepareConnectorExecutionInput): Promise<AuthorizedConnectorExecution> {
    this.registry.assertAvailable();
    if (!isServerPrincipal(input.principal)) {
      return refuse(
        'CONNECTOR_PRINCIPAL_REQUIRED',
        'Connector execution requires a verified caller.'
      );
    }
    const actor = await this.resolveActor(input.principal, input.requestedAgentId);
    return this.prepareResolved(input, actor);
  }

  /**
   * Re-read every synchronous connector fact after the final asynchronous principal check.
   *
   * Only an execution minted by this service can supply the actor established by the earlier
   * owner check. The broker calls this without another await before allowing provider dispatch.
   */
  recheckPreparedSynchronously(
    input: PrepareConnectorExecutionInput,
    prepared: AuthorizedConnectorExecution
  ): AuthorizedConnectorExecution {
    this.registry.assertAvailable();
    if (!isServerPrincipal(input.principal) || !this.preparedExecutions.has(prepared)) {
      return refuse(
        'CONNECTOR_PRINCIPAL_REQUIRED',
        'Connector execution requires a verified caller.'
      );
    }
    return this.prepareResolved(input, {
      actorKind: prepared.actorKind,
      actorId: prepared.actorId,
      agentId: prepared.agentId,
      ...(prepared.sessionId ? { sessionId: prepared.sessionId } : {}),
    });
  }

  private prepareResolved(
    input: PrepareConnectorExecutionInput,
    actor: ResolvedExecutionActor
  ): AuthorizedConnectorExecution {
    const row = this.readExecutionRow(input.target);
    const owner = ownerColumns(input.principal.claims.owner);
    if (
      !row.ownerKind ||
      !row.ownerId ||
      row.ownerKind !== owner.ownerKind ||
      row.ownerId !== owner.ownerId
    ) {
      return refuse(
        'CONNECTOR_OWNER_MISMATCH',
        'The selected connection does not belong to this caller.'
      );
    }
    if (
      row.lifecycleState !== 'connected' ||
      !row.enabled ||
      row.connectionStatus !== 'active' ||
      row.reconciliationStatus !== 'ready' ||
      row.providerStatus !== 'available' ||
      !row.executionConfigDigest ||
      row.executionConfigGeneration < 1
    ) {
      return refuse(
        'CONNECTOR_NOT_EXECUTABLE',
        'The selected connection is not ready for execution.'
      );
    }
    const expectedClassification = CLASSIFICATION_BY_CAPABILITY[input.capabilityId];
    if (row.classification !== expectedClassification) {
      return refuse(
        'CONNECTOR_CAPABILITY_MISMATCH',
        'The operation classification does not match this execution capability.'
      );
    }
    if (row.toolkit !== row.operationToolkit) {
      return refuse(
        'CONNECTOR_REVISION_MISMATCH',
        'The operation does not belong to this connection.'
      );
    }
    if (!this.hasGrant(actor.agentId, actor.sessionId, input.target)) {
      return refuse(
        'CONNECTOR_GRANT_REQUIRED',
        'This agent is not granted the selected operation.'
      );
    }
    const provider = this.registry.resolveProviderInstance(
      ConnectorOperationRevisionSchema.shape.providerInstanceId.parse(row.providerInstanceId)
    );
    if (!provider || provider.type !== row.providerType) {
      return refuse(
        'CONNECTOR_PROVIDER_UNAVAILABLE',
        'The selected connection provider is unavailable.'
      );
    }
    if (provider.getCapabilities().capabilities.execution.status !== 'available') {
      return refuse(
        'CONNECTOR_EXECUTION_UNSUPPORTED',
        'This provider does not support operation execution.'
      );
    }
    const argumentsValue = this.validateArguments(row.inputSchemaJson, input.target.arguments);
    const operation = ConnectorOperationRevisionSchema.parse({
      id: row.operationRevisionId,
      providerInstanceId: row.providerInstanceId,
      toolkit: row.operationToolkit,
      operationSlug: row.operationSlug,
      toolkitVersion: row.toolkitVersion,
      schemaHash: row.schemaHash,
      capabilityClassification: row.classification,
      retryPolicy: row.retryPolicy,
      inputSchema: JSON.parse(row.inputSchemaJson),
      discoveredAt: row.discoveredAt,
    });
    const digest = authorityDigest({
      capabilityId: input.capabilityId,
      owner,
      actor,
      connectionId: row.connectionId,
      providerInstanceId: row.providerInstanceId,
      executionConfigGeneration: row.executionConfigGeneration,
      operationRevisionId: row.operationRevisionId,
      arguments: argumentsValue,
    });
    const authorityBinding = createCapabilityAuthorityBinding({
      digest,
      ...owner,
      agentId: actor.agentId,
      ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
      connectionId: row.connectionId,
      operationRevisionId: row.operationRevisionId,
    });
    const authorized = Object.freeze({
      authorityBinding,
      owner: input.principal.claims.owner,
      actorKind: actor.actorKind,
      actorId: actor.actorId,
      agentId: actor.agentId,
      ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
      provider,
      externalAccountRef:
        row.externalAccountRef as AuthorizedConnectorExecution['externalAccountRef'],
      operation,
      arguments: Object.freeze({ ...argumentsValue }),
      executionConfigGeneration: row.executionConfigGeneration,
      payer: row.providerMode === 'managed' ? 'dorkos_managed' : 'operator_byo',
    });
    this.preparedExecutions.add(authorized);
    return authorized;
  }

  private async resolveActor(
    principal: ServerPrincipalProof,
    requestedAgentId?: string
  ): Promise<ResolvedExecutionActor> {
    const { claims } = principal;
    if (claims.kind === 'runtime') {
      if (requestedAgentId !== undefined) {
        return refuse(
          'CONNECTOR_AGENT_OVERRIDE_DENIED',
          'Runtime execution cannot override its bound agent.'
        );
      }
      return {
        actorKind: 'runtime',
        actorId: claims.bindingId,
        agentId: claims.agentId,
        sessionId: claims.canonicalSessionId,
      };
    }
    if (claims.kind === 'agent') {
      if (requestedAgentId !== undefined && requestedAgentId !== claims.agentId) {
        return refuse(
          'CONNECTOR_AGENT_OVERRIDE_DENIED',
          'An agent cannot borrow another agent’s grants.'
        );
      }
      return { actorKind: 'agent', actorId: claims.agentId, agentId: claims.agentId };
    }
    if (claims.kind === 'program' || claims.kind === 'operator') {
      if (!requestedAgentId) {
        return refuse(
          'CONNECTOR_AGENT_REQUIRED',
          'Choose the owned agent whose connector grants apply.'
        );
      }
      if (!(await this.agentOwnership.ownsAgent(claims.owner, requestedAgentId))) {
        return refuse(
          'CONNECTOR_AGENT_NOT_OWNED',
          'The selected agent does not belong to this caller.'
        );
      }
      return {
        actorKind: claims.kind,
        actorId:
          claims.kind === 'program' ? claims.credentialId : ownerColumns(claims.owner).ownerId,
        agentId: requestedAgentId,
      };
    }
    return refuse(
      'CONNECTOR_CALLER_UNSUPPORTED',
      'This caller cannot execute connector operations.'
    );
  }

  private readExecutionRow(target: ConnectorExecutionTarget): ExecutionRow {
    const row = this.db
      .select({
        connectionId: connections.id,
        externalAccountRef: connections.externalAccountRef,
        toolkit: connections.toolkit,
        connectionStatus: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        reconciliationStatus: connections.grantReconciliationStatus,
        providerInstanceId: connectorProviderInstances.id,
        providerType: connectorProviderInstances.type,
        providerMode: connectorProviderInstances.mode,
        providerStatus: connectorProviderInstances.status,
        executionConfigDigest: connectorProviderInstances.executionConfigDigest,
        executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
        operationRevisionId: connectorOperationRevisions.id,
        operationToolkit: connectorOperationRevisions.toolkit,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        schemaHash: connectorOperationRevisions.schemaHash,
        classification: connectorOperationRevisions.capabilityClassification,
        retryPolicy: connectorOperationRevisions.retryPolicy,
        inputSchemaJson: connectorOperationRevisions.inputSchemaJson,
        discoveredAt: connectorOperationRevisions.discoveredAt,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .innerJoin(
        connectorOperationRevisions,
        and(
          eq(connectorOperationRevisions.id, target.operationRevisionId),
          eq(connectorOperationRevisions.providerInstanceId, connections.providerInstanceId)
        )
      )
      .where(eq(connections.id, target.connectionId))
      .get();
    if (!row) {
      return refuse(
        'CONNECTOR_TARGET_NOT_FOUND',
        'The selected connection or operation was not found.'
      );
    }
    return row;
  }

  private hasGrant(
    agentId: string,
    sessionId: string | undefined,
    target: ConnectorExecutionTarget
  ): boolean {
    let subjectScope = and(
      eq(connectionOperationGrants.subjectType, 'agent'),
      eq(connectionOperationGrants.subjectId, agentId)
    );
    if (sessionId) {
      const override = this.db
        .select({
          state: sessionConnectionOverrides.state,
          agentId: sessionConnectionOverrides.agentId,
          needsReconciliation: sessionConnectionOverrides.needsReconciliation,
        })
        .from(sessionConnectionOverrides)
        .where(
          and(
            eq(sessionConnectionOverrides.sessionId, sessionId),
            eq(sessionConnectionOverrides.connectionId, target.connectionId)
          )
        )
        .get();
      if (
        override &&
        (override.agentId !== agentId ||
          override.needsReconciliation ||
          override.state === 'detached')
      ) {
        return false;
      }
      if (override?.state === 'attached') {
        subjectScope = and(
          eq(connectionOperationGrants.subjectType, 'session'),
          eq(connectionOperationGrants.subjectId, sessionId),
          eq(connectionOperationGrants.agentId, agentId)
        );
      }
    }
    return Boolean(
      this.db
        .select({ id: connectionOperationGrants.id })
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.connectionId, target.connectionId),
            eq(connectionOperationGrants.operationRevisionId, target.operationRevisionId),
            isNull(connectionOperationGrants.revokedAt),
            subjectScope
          )
        )
        .get()
    );
  }

  private validateArguments(
    inputSchemaJson: string,
    argumentsValue: Record<string, unknown>
  ): Record<string, unknown> {
    if (!isPlainJson(argumentsValue)) {
      return refuse('CONNECTOR_ARGUMENTS_INVALID', 'Connector arguments must be plain JSON data.');
    }
    try {
      const schema = z.fromJSONSchema(JSON.parse(inputSchemaJson));
      const parsed = schema.parse(argumentsValue);
      if (
        !isPlainJson(parsed) ||
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        stableStringify(parsed) !== stableStringify(argumentsValue)
      ) {
        return refuse(
          'CONNECTOR_ARGUMENTS_INVALID',
          'Connector arguments must exactly match the immutable operation schema.'
        );
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof CapabilityToolError) throw error;
      return refuse(
        'CONNECTOR_ARGUMENTS_INVALID',
        'Connector arguments do not match the immutable operation schema.'
      );
    }
  }
}
