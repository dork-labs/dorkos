/** Turn-scoped structural connector authority for Claude Code MCP tools. */
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import type {
  OpenConnectorTurnResult,
  RevokeConnectorTurnReason,
} from '../../connectors/runtime-principal-port.js';
import type { ConnectorRuntimeTools } from '../connector-tools.js';

/** Inputs whose live values identify one Claude turn. */
export interface ClaudeConnectorTurnContextOptions {
  /** Server-owned binding lifecycle and exact capability predicate. */
  readonly tools: ConnectorRuntimeTools;
  /** Reads the SDK id after first-turn canonical rekey. */
  readonly canonicalSessionId: () => string;
  /** Canonical registered agent path. */
  readonly agentPath: string;
  /** Working directory bound to the turn. */
  readonly cwd: string;
}

/**
 * Lazily opens and resolves one Claude connector principal.
 *
 * A persistent Claude process may host many DorkOS turns. This object belongs
 * to exactly one turn and is read through the mutable `AgentSession` at tool
 * call time, so a warm MCP server can never retain the prior turn's authority.
 */
export class ClaudeConnectorTurnContext {
  private readonly controller = new AbortController();
  private opening: Promise<ServerPrincipalProof> | undefined;
  private binding: OpenConnectorTurnResult | undefined;
  private revocation: Promise<void> | undefined;

  constructor(private readonly options: ClaudeConnectorTurnContextOptions) {}

  /** Whether the broker's exact allowlist marks this as connector execution. */
  isConnectorCapabilityId(id: string): boolean {
    return this.options.tools.isConnectorCapabilityId(id);
  }

  /** Open and resolve the structural principal on the first connector call. */
  resolvePrincipal(): Promise<ServerPrincipalProof> {
    this.opening ??= this.openAndResolve();
    return this.opening;
  }

  /** Cancel pending setup and revoke an already-open binding immediately. */
  cancel(): Promise<void> {
    return this.revoke('turn_cancelled');
  }

  /** Whether interruption cancelled this turn. */
  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Revoke the binding once, if this turn ever opened one.
   *
   * @param reason - Terminal state observed by the runtime generator.
   */
  async revoke(reason: RevokeConnectorTurnReason): Promise<void> {
    if (reason === 'turn_cancelled') this.controller.abort();
    await this.opening?.catch(() => undefined);
    await this.revokeBinding(reason);
  }

  private async openAndResolve(): Promise<ServerPrincipalProof> {
    const binding = await this.options.tools.principals.openTurn({
      runtime: 'claude-code',
      canonicalSessionId: this.options.canonicalSessionId(),
      agentPath: this.options.agentPath,
      canonicalCwd: this.options.cwd,
      signal: this.controller.signal,
    });
    this.binding = binding;
    if (this.controller.signal.aborted) {
      await this.revokeBinding('turn_cancelled');
      throw this.controller.signal.reason;
    }

    const resolved = await this.options.tools.principals.resolve({
      bearer: binding.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: this.options.cwd,
    });
    if (resolved.status === 'refused') {
      await this.revokeBinding('setup_failed');
      throw new Error('Connector tools are unavailable for this Claude turn.');
    }
    return resolved.principal;
  }

  private async revokeBinding(reason: RevokeConnectorTurnReason): Promise<void> {
    if (!this.binding) return;
    this.revocation ??= this.options.tools.principals.revoke(this.binding.bindingId, reason);
    await this.revocation;
  }
}
