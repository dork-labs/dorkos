/** Live, provider-neutral authorization for one exact connector execution. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  and,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
import { stableStringify } from '@dorkos/shared/capabilities';
import { checkConnectorArguments } from '@dorkos/shared/connector-arguments';
import {
  ConnectorOperationRevisionSchema,
  type ConnectorExecutionTarget,
  type ConnectorOperationClassification,
  type ConnectorOperationRevision,
} from '@dorkos/shared/connector-schemas';
import {
  type ConnectorExternalAccountRef,
  type ConnectorProvider,
} from '@dorkos/shared/connector-provider';
import type { ApprovalServiceAction } from '@dorkos/shared/approval-schemas';
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
import {
  deriveConnectionReadiness,
  registryWayHealth,
  type ConnectionReadinessFacts,
  type ConnectionWayHealthPort,
} from '../readiness/connection-readiness.js';
import { agentGrantScope, type AgentGrantDenial } from './agent-grant-scope.js';
import { describeServiceAction } from './approval-service-action.js';
import { managedAgentAccess } from './managed-agent-access.js';

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
  /**
   * The app, account, action and arguments in words, for an approval card.
   * Read from the stored connection and action, never from the caller.
   */
  readonly serviceAction: ApprovalServiceAction;
  /** Latest applied hosted grant scope, present only for managed execution. */
  readonly managedGrantScopeVersion?: number;
  /**
   * Which hosted grant scope `managedGrantScopeVersion` names: the agent's own,
   * or the owner-wide every-agent scope (DOR-2439). Managed execution only.
   */
  readonly managedGrantSubject?: 'agent' | 'every_agent';
  /** Private hosted revision identity derived from the granted local immutable revision. */
  readonly managedHostedRevisionId?: string;
}

interface ExecutionRow {
  connectionId: string;
  externalAccountRef: string;
  toolkit: string;
  connectionLabel: string;
  identityHint: string | null;
  connectionStatus: 'active' | 'expired' | 'revoked' | 'pending';
  lifecycleState: 'connected' | 'disconnected';
  enabled: boolean;
  pausedBy: 'owner' | 'sign_in' | null;
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
  providerRevisionRef: string;
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

/** What an agent reads when an account isn't ready but readiness can't name why. */
const NOT_READY_FALLBACK =
  'This account isn’t ready to use right now. Try again in a few minutes, and tell the person if it keeps happening.';

/** SQLite-backed live connector authorization. */
export class ConnectorExecutionAuthorizationService {
  private readonly preparedExecutions = new WeakSet<object>();
  private readonly wayHealth: ConnectionWayHealthPort;

  /**
   * Construct the authorization service over canonical stores and live providers.
   *
   * @param wayHealth - The live health of the way behind an account, for
   *   refusals that say why it can't be used. Without it, only the registry is read.
   */
  constructor(
    private readonly db: Db,
    private readonly registry: ConnectorRegistry,
    private readonly agentOwnership: ConnectorAgentOwnershipPort,
    wayHealth?: ConnectionWayHealthPort
  ) {
    this.wayHealth = wayHealth ?? registryWayHealth(registry);
  }

  /**
   * Refuse a call on an account that isn't ready, with the readiness words for
   * the agent: why, and what the person must do (DOR-2500).
   */
  private refuseNotReady(
    code: string,
    row: ExecutionRow,
    extra: Partial<ConnectionReadinessFacts> = {}
  ): never {
    const readiness = deriveConnectionReadiness({
      lifecycle:
        row.lifecycleState === 'disconnected'
          ? 'disconnected'
          : row.enabled
            ? 'connected'
            : 'paused',
      pausedBy: row.pausedBy,
      authenticationStatus: row.connectionStatus,
      reconciliationStatus: row.reconciliationStatus,
      mode: row.providerMode,
      toolkit: row.toolkit,
      way: this.wayHealth(row.providerInstanceId, row.toolkit),
      ...extra,
    });
    if (readiness.state === 'ready') return refuse(code, NOT_READY_FALLBACK);
    throw new CapabilityToolError({
      error: readiness.copy.agent,
      code,
      reason: readiness.reason,
    });
  }

  /** Produce the authenticated preflight result consumed by the registry tier gate. */
  async preflight(input: PrepareConnectorExecutionInput): Promise<CapabilityPreflightResult> {
    const authorized = await this.prepare(input);
    return {
      authorityBinding: authorized.authorityBinding,
      approvalServiceAction: authorized.serviceAction,
    };
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
        'DorkOS couldn’t tell who is running this action, so it didn’t run.'
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
        'DorkOS couldn’t tell who is running this action, so it didn’t run.'
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
        'DorkOS couldn’t tell who is running this action, so it didn’t run.'
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
      return refuse('CONNECTOR_OWNER_MISMATCH', 'That account isn’t one this agent can use.');
    }
    if (
      row.lifecycleState === 'connected' &&
      row.enabled &&
      (row.connectionStatus === 'expired' || row.connectionStatus === 'revoked')
    ) {
      // The service said this sign-in ended; readiness names the one fix.
      return this.refuseNotReady('CONNECTOR_SIGN_IN_ENDED', row);
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
      return this.refuseNotReady('CONNECTOR_NOT_EXECUTABLE', row);
    }
    const expectedClassification = CLASSIFICATION_BY_CAPABILITY[input.capabilityId];
    if (row.classification !== expectedClassification) {
      return refuse(
        'CONNECTOR_CAPABILITY_MISMATCH',
        'This action is a different kind than this tool runs. Use the tool named for its kind: the read, write or destructive tool.'
      );
    }
    if (row.toolkit !== row.operationToolkit) {
      return refuse(
        'CONNECTOR_REVISION_MISMATCH',
        'The operation does not belong to this connection.'
      );
    }
    const granted = this.matchingGrants(actor.agentId, actor.sessionId, input.target);
    if (granted.denied === 'detached') {
      return this.refuseNotReady('CONNECTOR_GRANT_REQUIRED', row, { offForThisChat: true });
    }
    if (!granted.named && !granted.everyAgent) {
      return refuse(
        'CONNECTOR_GRANT_REQUIRED',
        'This agent is not granted the selected operation.'
      );
    }
    const provider = this.registry.resolveProviderInstance(
      ConnectorOperationRevisionSchema.shape.providerInstanceId.parse(row.providerInstanceId)
    );
    if (!provider || provider.type !== row.providerType) {
      return this.refuseNotReady('CONNECTOR_PROVIDER_UNAVAILABLE', row);
    }
    if (provider.getCapabilities().capabilities.execution.status !== 'available') {
      return this.refuseNotReady('CONNECTOR_EXECUTION_UNSUPPORTED', row);
    }
    const managedHostedRevisionId =
      row.providerMode === 'managed'
        ? z.string().uuid().safeParse(row.providerRevisionRef)
        : undefined;
    if (managedHostedRevisionId && !managedHostedRevisionId.success) {
      return refuse(
        'CONNECTOR_MANAGED_REVISION_REQUIRED',
        'The person needs to review this action again before you can use it. Ask them to check this account’s access on the Connections page in the DorkOS app.'
      );
    }
    const argumentsValue = this.validateArguments(row.inputSchemaJson, input.target.arguments);
    const managedAccess =
      row.providerMode === 'managed'
        ? managedAgentAccess(this.db, row.externalAccountRef, actor.agentId, granted)
        : undefined;
    const managedGrantScopeVersion = managedAccess?.applied?.scopeVersion;
    const managedGrantSubject = managedAccess?.applied?.subject;
    if (managedAccess && managedGrantScopeVersion === undefined) {
      return this.refuseNotReady('CONNECTOR_MANAGED_AUTHORITY_PENDING', row, {
        authoritySync: managedAccess.sync,
      });
    }
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
      managedGrantScopeVersion,
      managedGrantSubject,
      hostedRevisionId: managedHostedRevisionId?.success ? managedHostedRevisionId.data : undefined,
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
      serviceAction: describeServiceAction({
        toolkit: row.toolkit,
        connectionLabel: row.connectionLabel,
        identityHint: row.identityHint,
        operationSlug: row.operationSlug,
        inputSchema: operation.inputSchema,
        arguments: argumentsValue,
      }),
      executionConfigGeneration: row.executionConfigGeneration,
      payer: row.providerMode === 'managed' ? 'dorkos_managed' : 'operator_byo',
      ...(managedGrantScopeVersion === undefined ? {} : { managedGrantScopeVersion }),
      ...(managedGrantSubject === undefined ? {} : { managedGrantSubject }),
      ...(managedHostedRevisionId?.success
        ? { managedHostedRevisionId: managedHostedRevisionId.data }
        : {}),
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
          'This action runs as the agent in this chat. It can’t run as another agent.'
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
          'An agent can’t use another agent’s access.'
        );
      }
      return { actorKind: 'agent', actorId: claims.agentId, agentId: claims.agentId };
    }
    if (claims.kind === 'program' || claims.kind === 'operator') {
      if (!requestedAgentId) {
        return refuse('CONNECTOR_AGENT_REQUIRED', 'Say which of your agents this action runs as.');
      }
      if (!(await this.agentOwnership.ownsAgent(claims.owner, requestedAgentId))) {
        return refuse('CONNECTOR_AGENT_NOT_OWNED', 'That agent isn’t one of yours.');
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
      'Only an agent, or a program the person allowed, can run app actions.'
    );
  }

  private readExecutionRow(target: ConnectorExecutionTarget): ExecutionRow {
    const row = this.db
      .select({
        connectionId: connections.id,
        externalAccountRef: connections.externalAccountRef,
        toolkit: connections.toolkit,
        connectionLabel: connections.label,
        identityHint: connections.identityHint,
        connectionStatus: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        pausedBy: connections.pausedBy,
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
        providerRevisionRef: connectorOperationRevisions.providerRevisionRef,
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

  /**
   * Which live grants allow this agent this exact revision right now. Which
   * grants count (a session override deciding alone, then the agent's own and
   * "Every agent") is `agentGrantScope`, the one definition the agent request
   * service shares. `named` covers the agent's own and its session's grants,
   * `everyAgent` the owner-wide grant.
   */
  private matchingGrants(
    agentId: string,
    sessionId: string | undefined,
    target: ConnectorExecutionTarget
  ): { named: boolean; everyAgent: boolean; denied?: AgentGrantDenial } {
    const scope = agentGrantScope(this.db, {
      agentId,
      sessionId,
      connectionId: target.connectionId,
    });
    if (scope.kind === 'denied') return { named: false, everyAgent: false, denied: scope.reason };
    const subjects = this.db
      .select({ subjectType: connectionOperationGrants.subjectType })
      .from(connectionOperationGrants)
      .where(
        and(
          eq(connectionOperationGrants.connectionId, target.connectionId),
          eq(connectionOperationGrants.operationRevisionId, target.operationRevisionId),
          isNull(connectionOperationGrants.revokedAt),
          scope.subject
        )
      )
      .all()
      .map((row) => row.subjectType);
    return {
      named: subjects.some((subject) => subject !== 'every_agent'),
      everyAgent: subjects.includes('every_agent'),
    };
  }

  /**
   * The arguments exactly as the agent sent them, once they satisfy the
   * operation's frozen input schema. Nothing is filled in, coerced or dropped:
   * the digest binds, the audit records and the provider receives this very
   * object, and the provider applies its own defaults (`checkConnectorArguments`).
   */
  private validateArguments(
    inputSchemaJson: string,
    argumentsValue: Record<string, unknown>
  ): Record<string, unknown> {
    if (!isPlainJson(argumentsValue)) {
      return refuse('CONNECTOR_ARGUMENTS_INVALID', 'Connector arguments must be plain JSON data.');
    }
    let inputSchema: unknown;
    try {
      inputSchema = JSON.parse(inputSchemaJson);
    } catch {
      inputSchema = undefined;
    }
    const check =
      inputSchema !== null && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
        ? checkConnectorArguments(inputSchema as Record<string, unknown>, argumentsValue)
        : ({ ok: false, reason: 'schema_unreadable' } as const);
    if (check.ok) return argumentsValue;
    if (check.reason === 'schema_unreadable') {
      return refuse(
        'CONNECTOR_ARGUMENTS_INVALID',
        "This operation's input schema cannot be checked, so it cannot run."
      );
    }
    return refuse(
      'CONNECTOR_ARGUMENTS_INVALID',
      check.problem
        ? `Connector arguments do not match the operation's input schema: ${check.problem}.`
        : "Connector arguments do not match the operation's input schema."
    );
  }
}
