/** Turn-scoped structural connector authority for Claude Code MCP tools. */
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import type {
  OpenConnectorTurnResult,
  RevokeConnectorTurnReason,
} from '../../connectors/runtime-principal-port.js';
import type { ConnectorRuntimeTools } from '../connector-tools.js';
import { logger } from '../../../lib/logger.js';
import { aliasTurnLevel } from '../../core/turn-power/turn-levels.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorTurnLeaseSupervisorHandle,
} from '../connectors/connector-turn-lease-supervisor.js';

/** Inputs whose live values identify one Claude turn. */
export interface ClaudeConnectorTurnContextOptions {
  /** Server-owned binding lifecycle and exact capability predicate. */
  readonly tools: ConnectorRuntimeTools;
  /** Reads the SDK id after first-turn canonical rekey. */
  readonly canonicalSessionId: () => string;
  /**
   * The id this turn was sent with, under which its level and outside-words note are kept
   * (`turn-levels.ts`). Carried to the SDK id as the binding opens (DOR-4587).
   */
  readonly sentSessionId?: string;
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
  private supervisor: ConnectorTurnLeaseSupervisorHandle | undefined;
  private active = true;

  constructor(private readonly options: ClaudeConnectorTurnContextOptions) {}

  /** Whether the broker's exact allowlist marks this as connector execution. */
  isConnectorCapabilityId(id: string): boolean {
    return this.options.tools.isConnectorCapabilityId(id);
  }

  /** Open and resolve the structural principal on the first connector call. */
  async resolvePrincipal(): Promise<ServerPrincipalProof> {
    this.assertCurrent();
    this.supervisor?.assertUsable();
    this.opening ??= this.openAndResolve();
    await this.opening;
    this.assertCurrent();
    const binding = this.binding;
    if (!binding) throw new Error('Runtime tools are unavailable for this Claude turn.');
    this.assertCurrent();
    const resolved = await this.options.tools.principals.resolve({
      bearer: binding.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: this.options.cwd,
    });
    this.assertCurrent();
    this.supervisor?.assertUsable();
    if (resolved.status === 'refused') {
      await this.revoke('setup_failed');
      throw new Error('Runtime tools are unavailable for this Claude turn.');
    }
    return resolved.principal;
  }

  private assertCurrent(): void {
    if (!this.active) throw new Error('Claude runtime turn is retired.');
    this.controller.signal.throwIfAborted();
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
    this.active = false;
    this.supervisor?.stop();
    if (reason === 'turn_cancelled') this.controller.abort();
    await this.opening?.catch(() => undefined);
    await this.revokeBinding(reason);
  }

  private async openAndResolve(): Promise<ServerPrincipalProof> {
    this.assertCurrent();
    const canonicalSessionId = this.options.canonicalSessionId();
    // The send gate reads this turn under the id the binding is fixed to (DOR-4587). The turn's
    // level and its outside-words note are kept under the id it was sent with, and the other
    // carries (the room runner's, the one-shot rekey) can run after this call or never reach
    // this id. Carry them here, so the gate reads THIS turn and never an older one.
    const sent = this.options.sentSessionId;
    if (sent !== undefined && sent !== canonicalSessionId) aliasTurnLevel(sent, canonicalSessionId);
    const binding = await this.options.tools.principals.openTurn(
      {
        runtime: 'claude-code',
        canonicalSessionId,
        agentPath: this.options.agentPath,
        canonicalCwd: this.options.cwd,
        signal: this.controller.signal,
      },
      { isCurrent: () => this.active }
    );
    this.binding = binding;
    if (this.controller.signal.aborted) {
      await this.revokeBinding('turn_cancelled');
      throw this.controller.signal.reason;
    }

    this.assertCurrent();
    const resolved = await this.options.tools.principals.resolve({
      bearer: binding.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: this.options.cwd,
    });
    if (resolved.status === 'refused') {
      await this.revokeBinding('setup_failed');
      throw new Error('Connector tools are unavailable for this Claude turn.');
    }
    this.assertCurrent();
    const createSupervisor =
      this.options.tools.createLeaseSupervisor ??
      ((options) => new ConnectorTurnLeaseSupervisor(options));
    this.supervisor = createSupervisor({
      principals: this.options.tools.principals,
      bindingId: binding.bindingId,
      permit: binding.renewalPermit,
      runtime: 'claude-code',
      expiresAt: binding.expiresAt,
      signal: this.controller.signal,
      onLost: (loss) => logger.warn('[ClaudeCodeRuntime] Connections lease lost', loss),
    });
    return resolved.principal;
  }

  private async revokeBinding(reason: RevokeConnectorTurnReason): Promise<void> {
    if (!this.binding) return;
    this.revocation ??= this.options.tools.principals.revoke(this.binding.bindingId, reason);
    await this.revocation;
  }
}

/**
 * The connector context for one Claude turn, or none when the runtime has no connector tools or the
 * turn acts as no registered agent. It reads the SDK id at the first connector call and carries the
 * turn's record from the id the turn was sent with (DOR-4587).
 *
 * @param tools - The runtime's connector tools, when wired.
 * @param agent - The registered agent the turn acts as, when there is one.
 * @param turn - The session, the id the turn was sent with, and its working directory.
 */
export function claudeConnectorTurn(
  tools: ConnectorRuntimeTools | undefined,
  agent: { readonly agentPath: string } | undefined,
  turn: {
    readonly session: { readonly sdkSessionId?: string | null };
    readonly sessionId: string;
    readonly cwd: string;
  }
): ClaudeConnectorTurnContext | undefined {
  if (!tools || !agent) return undefined;
  return new ClaudeConnectorTurnContext({
    tools,
    canonicalSessionId: () => turn.session.sdkSessionId || turn.sessionId,
    sentSessionId: turn.sessionId,
    agentPath: agent.agentPath,
    cwd: turn.cwd,
  });
}
