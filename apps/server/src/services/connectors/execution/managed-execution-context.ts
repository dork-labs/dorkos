/** Private per-command context consumed only by the managed connector provider. */
import type { ManagedConnectorExecutionAttribution } from '@dorkos/shared/connector-managed-schemas';
import type { ConnectorProviderExecuteCommand } from '@dorkos/shared/connector-schemas';

/** Trusted hosted execution fields derived by the local broker. */
export interface ManagedConnectorExecutionContext {
  /** Agent whose current hosted grant scope authorizes this call. */
  readonly agentId: string;
  /** One-based attempt index within the broker's logical operation. */
  readonly attemptIndex: number;
  /** Exact hosted agent-grant scope version that must authorize dispatch. */
  readonly grantScopeVersion: number;
  /** Private hosted revision identity from the granted immutable local revision. */
  readonly hostedRevisionId: string;
  /** Verified local caller attribution retained by hosted usage evidence. */
  readonly attribution: ManagedConnectorExecutionAttribution;
}

/** Broker-side command identity binding used by the managed provider adapter. */
export interface ManagedConnectorExecutionContextBindingPort {
  /** Bind trusted context to the exact command object before provider entry. */
  bind(command: ConnectorProviderExecuteCommand, context: ManagedConnectorExecutionContext): void;
}

/**
 * One-shot WeakMap binding between a server-created provider command and its
 * managed-only execution context. Public DTOs cannot manufacture a key, and a
 * provider cannot reuse context from a completed call.
 */
export class ManagedConnectorExecutionContextStore implements ManagedConnectorExecutionContextBindingPort {
  private readonly contexts = new WeakMap<
    ConnectorProviderExecuteCommand,
    ManagedConnectorExecutionContext
  >();

  /** Bind one exact command identity, refusing accidental rebinding. */
  bind(command: ConnectorProviderExecuteCommand, context: ManagedConnectorExecutionContext): void {
    if (this.contexts.has(command)) {
      throw new Error('Managed connector execution context is already bound.');
    }
    this.contexts.set(command, Object.freeze({ ...context }));
  }

  /** Resolve and consume context for the exact command identity once. */
  resolve(command: ConnectorProviderExecuteCommand): ManagedConnectorExecutionContext | undefined {
    const context = this.contexts.get(command);
    if (context) this.contexts.delete(command);
    return context;
  }
}
