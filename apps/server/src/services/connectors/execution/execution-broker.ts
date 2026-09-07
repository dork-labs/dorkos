/** DorkOS-owned connector dispatch, retry, and append-only usage evidence. */
import { ulid } from 'ulidx';
import type {
  ConnectorExecutionResponse,
  ConnectorExecutionTarget,
  ConnectorProviderExecuteResult,
} from '@dorkos/shared/connector-schemas';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import type { GrantedApproval } from '../../core/capabilities/tier-enforcement.js';
import {
  isCapabilityAuthorityBinding,
  type CapabilityAuthorityBindingProof,
} from '../principal/capability-authority-binding.js';
import type { ServerPrincipalProof } from '../principal/server-principal.js';
import type { ConnectorRuntimeExecutionCapabilityId } from '../runtime-capability-scope.js';
import {
  ConnectorExecutionAuthorizationService,
  type AuthorizedConnectorExecution,
} from './authorization-service.js';
import { ConnectorUsageStore, type ConnectorUsageOutcome } from './usage-store.js';
import type { ManagedConnectorExecutionContextBindingPort } from './managed-execution-context.js';

/** One fully parsed invocation reaching the execution broker after tier enforcement. */
export interface ConnectorBrokerExecutionInput {
  /** Exact classification capability invoked. */
  readonly capabilityId: ConnectorRuntimeExecutionCapabilityId;
  /** Public target after capability schema parsing. */
  readonly target: ConnectorExecutionTarget;
  /** Authenticated caller retained for every live recheck. */
  readonly principal: ServerPrincipalProof;
  /** Authenticated preflight proof established before the approval gate. */
  readonly authorityBinding: CapabilityAuthorityBindingProof;
  /** Approval consumed by the tier gate for a destructive operation. */
  readonly approval?: GrantedApproval;
  /** Named agent selected by an authorized program/operator surface. */
  readonly requestedAgentId?: string;
  /** Usage entry surface. */
  readonly surface: 'mcp' | 'rest' | 'cli' | 'event';
  /** Cancels this logical call and all of its attempts. */
  readonly signal: AbortSignal;
}

/** Live server-principal check performed before every provider attempt. */
export interface ConnectorExecutionPrincipalRevalidationPort {
  /** Return whether this exact authenticated principal still holds its server authority. */
  revalidate(principal: ServerPrincipalProof): boolean | Promise<boolean>;
}

function safePublicResult(
  result: ConnectorProviderExecuteResult
): ConnectorExecutionResponse['result'] {
  switch (result.status) {
    case 'success':
      return { status: result.status, data: result.data };
    case 'error':
      return { status: result.status, code: result.code, message: result.message };
    case 'cancelled':
      return { status: result.status, code: result.code, message: result.message };
    case 'outcome_unknown':
      return { status: result.status, code: result.code, message: result.message };
    case 'unsupported':
      return result;
  }
}

function receiptOutcome(result: ConnectorProviderExecuteResult): ConnectorUsageOutcome {
  return result.status;
}

function safeThrownProviderResult(): ConnectorProviderExecuteResult {
  return {
    status: 'outcome_unknown',
    code: 'PROVIDER_TRANSPORT_OUTCOME_UNKNOWN',
    message: 'The service did not confirm whether the operation completed.',
  };
}

/** Execute connector operations only after live authority and immutable intent. */
export class ConnectorExecutionBroker {
  /** Construct the broker over live authorization and append-only usage storage. */
  constructor(
    private readonly authorization: ConnectorExecutionAuthorizationService,
    private readonly usage: ConnectorUsageStore,
    private readonly principalRevalidation: ConnectorExecutionPrincipalRevalidationPort,
    private readonly now: () => Date = () => new Date(),
    private readonly managedExecutionContext?: ManagedConnectorExecutionContextBindingPort
  ) {}

  /** Dispatch one logical operation with at most one explicitly safe retry. */
  async execute(input: ConnectorBrokerExecutionInput): Promise<ConnectorExecutionResponse> {
    if (!isCapabilityAuthorityBinding(input.authorityBinding)) {
      throw new CapabilityToolError({
        error: 'Connector execution requires authenticated preflight authority.',
        code: 'CONNECTOR_PREFLIGHT_REQUIRED',
      });
    }
    const logicalOperationId = ulid();
    const upstreamIdempotencyKey = `dorkos:${logicalOperationId}`;
    let attemptCount = 0;
    const expectedDigest = input.authorityBinding.approvalScope.digest;
    let lastResult: ConnectorProviderExecuteResult | undefined;

    while (attemptCount < 2) {
      if (!(await this.principalRevalidation.revalidate(input.principal))) {
        if (lastResult) {
          return { logicalOperationId, attemptCount, result: safePublicResult(lastResult) };
        }
        throw new CapabilityToolError({
          error: 'Connector caller authority changed before dispatch.',
          code: 'CONNECTOR_PRINCIPAL_CHANGED',
        });
      }
      let authorized: AuthorizedConnectorExecution;
      try {
        authorized = await this.authorization.prepare({
          capabilityId: input.capabilityId,
          target: input.target,
          principal: input.principal,
          ...(input.requestedAgentId ? { requestedAgentId: input.requestedAgentId } : {}),
        });
      } catch (error) {
        if (lastResult) {
          return { logicalOperationId, attemptCount, result: safePublicResult(lastResult) };
        }
        throw error;
      }
      if (authorized.authorityBinding.approvalScope.digest !== expectedDigest) {
        throw new CapabilityToolError({
          error: 'Access changed before the operation was sent.',
          code: 'CONNECTOR_AUTHORITY_CHANGED',
        });
      }
      this.assertApprovalBinding(input.capabilityId, input.approval, expectedDigest);
      attemptCount += 1;
      const attemptId = ulid();
      const startedAt = this.now().toISOString();
      this.usage.recordIntent({
        attemptId,
        logicalOperationId,
        attemptIndex: attemptCount,
        surface: input.surface,
        actorKind: authorized.actorKind,
        actorId: authorized.actorId,
        owner: authorized.owner,
        agentId: authorized.agentId,
        ...(authorized.sessionId ? { sessionId: authorized.sessionId } : {}),
        connectionId: input.target.connectionId,
        providerInstanceId: authorized.operation.providerInstanceId,
        providerType: authorized.provider.type,
        payer: authorized.payer,
        operationRevisionId: authorized.operation.id,
        startedAt,
      });

      const result = await this.dispatchAttempt(
        authorized,
        input,
        expectedDigest,
        logicalOperationId,
        attemptId,
        attemptCount,
        upstreamIdempotencyKey,
        input.signal
      );
      lastResult = result;
      const recordedAt = this.now().toISOString();
      this.usage.appendTerminal({
        attemptId,
        logicalOperationId,
        owner: authorized.owner,
        providerInstanceId: authorized.operation.providerInstanceId,
        operationRevisionId: authorized.operation.id,
        outcome: receiptOutcome(result),
        ...('providerLogId' in result && result.providerLogId
          ? { providerLogId: result.providerLogId }
          : {}),
        ...('code' in result ? { errorCode: result.code } : {}),
        completedAt: recordedAt,
        recordedAt,
        provenance: 'broker',
      });

      if (!this.mayRetry(authorized, result, attemptCount, input.signal)) {
        return { logicalOperationId, attemptCount, result: safePublicResult(result) };
      }
    }

    throw new Error('Connector execution broker exceeded its two-attempt invariant.');
  }

  private assertApprovalBinding(
    capabilityId: ConnectorRuntimeExecutionCapabilityId,
    approval: GrantedApproval | undefined,
    digest: string
  ): void {
    if (capabilityId !== 'connectors.execute_destructive') return;
    if (!approval || approval.via !== 'approval' || approval.authorityBindingDigest !== digest) {
      throw new CapabilityToolError({
        error: 'Destructive connector execution requires approval for this exact authority.',
        code: 'CONNECTOR_APPROVAL_BINDING_MISMATCH',
      });
    }
  }

  private async dispatchAttempt(
    authorized: AuthorizedConnectorExecution,
    input: ConnectorBrokerExecutionInput,
    expectedDigest: string,
    logicalOperationId: string,
    attemptId: string,
    attemptIndex: number,
    upstreamIdempotencyKey: string,
    signal: AbortSignal
  ): Promise<ConnectorProviderExecuteResult> {
    if (signal.aborted) {
      return {
        status: 'cancelled',
        code: 'CANCELLED_BEFORE_DISPATCH',
        message: 'The operation was cancelled before it was sent.',
      };
    }
    try {
      const command = {
        externalAccountRef: authorized.externalAccountRef,
        operation: authorized.operation,
        arguments: authorized.arguments,
        logicalOperationId,
        attemptId,
        ...(authorized.operation.retryPolicy === 'provider_idempotency_key'
          ? { upstreamIdempotencyKey }
          : {}),
        signal,
        authorizeDispatch: () => this.revalidateFinalDispatch(input, expectedDigest, signal),
      };
      if (authorized.payer === 'dorkos_managed') {
        if (
          !this.managedExecutionContext ||
          authorized.managedGrantScopeVersion === undefined ||
          !authorized.managedHostedRevisionId
        ) {
          return {
            status: 'error',
            code: 'MANAGED_EXECUTION_CONTEXT_UNAVAILABLE',
            message: 'Managed account access is not ready.',
            retryable: false,
          };
        }
        this.managedExecutionContext.bind(command, {
          agentId: authorized.agentId,
          attemptIndex,
          grantScopeVersion: authorized.managedGrantScopeVersion,
          hostedRevisionId: authorized.managedHostedRevisionId,
          attribution: {
            surface: input.surface,
            actorKind: authorized.actorKind,
            actorId: authorized.actorId,
            ...(authorized.sessionId ? { sessionId: authorized.sessionId } : {}),
          },
        });
      }
      return await authorized.provider.execute(command);
    } catch {
      return safeThrownProviderResult();
    }
  }

  private async revalidateFinalDispatch(
    input: ConnectorBrokerExecutionInput,
    expectedDigest: string,
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted || !(await this.principalRevalidation.revalidate(input.principal))) {
      return false;
    }
    try {
      const current = await this.authorization.prepare({
        capabilityId: input.capabilityId,
        target: input.target,
        principal: input.principal,
        ...(input.requestedAgentId ? { requestedAgentId: input.requestedAgentId } : {}),
      });
      if (signal.aborted || !(await this.principalRevalidation.revalidate(input.principal))) {
        return false;
      }
      const finalCurrent = this.authorization.recheckPreparedSynchronously(
        {
          capabilityId: input.capabilityId,
          target: input.target,
          principal: input.principal,
          ...(input.requestedAgentId ? { requestedAgentId: input.requestedAgentId } : {}),
        },
        current
      );
      if (finalCurrent.authorityBinding.approvalScope.digest !== expectedDigest) return false;
      this.assertApprovalBinding(input.capabilityId, input.approval, expectedDigest);
      return true;
    } catch {
      return false;
    }
  }

  private mayRetry(
    authorized: AuthorizedConnectorExecution,
    result: ConnectorProviderExecuteResult,
    attemptCount: number,
    signal: AbortSignal
  ): boolean {
    return (
      attemptCount === 1 &&
      !signal.aborted &&
      authorized.operation.retryPolicy === 'provider_idempotency_key' &&
      result.status === 'error' &&
      result.retryable
    );
  }
}
