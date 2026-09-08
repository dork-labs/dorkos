/** Turn-bound agent identity snapshots layered over the runtime principal port. */
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type {
  ConnectorRuntimePrincipalPort,
  OpenConnectorTurnInput,
  OpenConnectorTurnResult,
  ResolveConnectorTurnInput,
  ResolveConnectorTurnResult,
  RevokeConnectorTurnReason,
} from '../../connectors/runtime-principal-port.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';

/** Dependencies for {@link AgentIdentitySnapshotPrincipalPort}. */
export interface AgentIdentitySnapshotPrincipalPortOptions {
  /** Existing authenticated turn-principal implementation. */
  readonly principals: ConnectorRuntimePrincipalPort;
  /** Resolve the agent identity immediately before the runtime is launched. */
  readonly snapshotIdentity: (agentPath: string) => Promise<AgentIdentity | undefined>;
  /** Recheck the trusted identity store for a later operator revocation. */
  readonly identityWasRevoked: (agentPath: string) => Promise<boolean>;
  /** Injectable clock for expiry tests. */
  readonly now?: () => Date;
}

interface SnapshotRecord {
  readonly identity: AgentIdentity;
  readonly runtime: OpenConnectorTurnInput['runtime'];
  readonly canonicalSessionId: string;
  readonly agentPath: string;
  readonly canonicalCwd?: string;
  readonly expiresAt: number;
}

/**
 * Decorate runtime principals with the exact agent identity seen before launch.
 *
 * The backing port remains the only bearer authenticator. This layer adds no
 * accepted credential and does not alter connector authorization; it remembers
 * the already verified turn's capability identity so stateless MCP requests do
 * not reread an agent-writable manifest. Concurrent turns keep distinct
 * snapshots under their distinct binding ids.
 */
export class AgentIdentitySnapshotPrincipalPort implements ConnectorRuntimePrincipalPort {
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly now: () => Date;

  /** Build the turn-bound identity layer. */
  constructor(private readonly options: AgentIdentitySnapshotPrincipalPortOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Capture identity before delegating creation of the authenticated turn bearer. */
  async openTurn(input: OpenConnectorTurnInput): Promise<OpenConnectorTurnResult> {
    this.pruneExpired();
    const identity = await this.options.snapshotIdentity(input.agentPath);
    input.signal.throwIfAborted();
    const opened = await this.options.principals.openTurn(input);
    if (identity && !identity.inactive && identity.agentPath === input.agentPath) {
      this.snapshots.set(opened.bindingId, {
        identity: Object.freeze({ ...identity }),
        runtime: input.runtime,
        canonicalSessionId: input.canonicalSessionId,
        agentPath: input.agentPath,
        ...(input.canonicalCwd ? { canonicalCwd: input.canonicalCwd } : {}),
        expiresAt: Date.parse(opened.expiresAt),
      });
    }
    return opened;
  }

  /** Delegate bearer resolution unchanged to the authenticated principal port. */
  resolve(input: ResolveConnectorTurnInput): Promise<ResolveConnectorTurnResult> {
    return this.options.principals.resolve(input);
  }

  /** Delete capability identity before the backing revocation can wait or fail. */
  async revoke(bindingId: string, reason: RevokeConnectorTurnReason): Promise<void> {
    this.snapshots.delete(bindingId);
    await this.options.principals.revoke(bindingId, reason);
  }

  /**
   * Resolve the immutable identity captured for an authenticated runtime proof.
   *
   * The mutable manifest is never consulted here. A later revocation in the
   * trusted identity store still shuts the agent route off, and any lookup
   * failure refuses rather than silently dropping to anonymous authority.
   */
  async identityFor(principal: ServerPrincipalProof): Promise<AgentIdentity | undefined> {
    this.pruneExpired();
    if (principal.claims.kind !== 'runtime') return undefined;
    const claims = principal.claims;
    const record = this.snapshots.get(claims.bindingId);
    if (
      !record ||
      record.runtime !== claims.runtime ||
      record.canonicalSessionId !== claims.canonicalSessionId ||
      record.agentPath !== claims.agentPath ||
      record.canonicalCwd !== claims.canonicalCwd
    ) {
      return undefined;
    }

    try {
      if (await this.options.identityWasRevoked(record.agentPath)) return undefined;
    } catch {
      return undefined;
    }
    if (this.snapshots.get(claims.bindingId) !== record) return undefined;
    return record.identity;
  }

  /** Bound abandoned records by the backing principal's own expiry ceiling. */
  private pruneExpired(): void {
    const now = this.now().getTime();
    for (const [bindingId, record] of this.snapshots) {
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) {
        this.snapshots.delete(bindingId);
      }
    }
  }
}
