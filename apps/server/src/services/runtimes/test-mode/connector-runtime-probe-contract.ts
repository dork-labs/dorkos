import type {
  ConnectorAgentConnectionRequestInput,
  ConnectorExecutionTarget,
} from '@dorkos/shared/connector-schemas';

/** Test-only bridge into the authenticated internal connector MCP listener. */
export interface ConnectorRuntimeRequestProbe {
  /** Open one real runtime principal, call the request tool, and close the turn. */
  (input: {
    readonly sessionId: string;
    readonly agentPath: string;
    readonly request: ConnectorAgentConnectionRequestInput;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** Test-only bridge for one authenticated runtime read through the internal connector listener. */
export interface ConnectorRuntimeExecutionProbe {
  /** Open one real runtime principal, call the read tool, and close the turn. */
  (input: {
    readonly sessionId: string;
    readonly agentPath: string;
    readonly target: ConnectorExecutionTarget;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}
