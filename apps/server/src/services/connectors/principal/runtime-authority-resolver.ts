/** Canonical session and Mesh authority for runtime connector turns. */
import type { OpenConnectorTurnInput, ConnectorRuntime } from '../runtime-principal-port.js';
import type {
  ConnectorRuntimeAuthority,
  ConnectorRuntimeAuthorityResolver,
} from './runtime-principal-service.js';
import type { ConnectorOwnerAuthority, ServerPrincipalClaims } from './server-principal.js';

/** Canonical session reads needed to authorize a runtime turn. */
export interface ConnectorRuntimeSessionAuthoritySource {
  /** Resolve the stored runtime and whether the session has a real binding. */
  resolveSessionRuntime(
    sessionId: string
  ): Promise<{ readonly type: string; readonly bound: boolean }>;
  /** Read the stored canonical agent path for the session. */
  getSessionAgentPath(sessionId: string): Promise<string | null>;
}

/** Canonical Mesh lookup needed to bind a path to one stable agent. */
export interface ConnectorRuntimeMeshAuthoritySource {
  /** Resolve a currently registered agent by its canonical project path. */
  getByPath(projectPath: string): { readonly id: string } | undefined;
}

/** Construction inputs for the canonical runtime authority resolver. */
export interface CanonicalConnectorRuntimeAuthorityOptions {
  /** Runtime registry backed by durable session metadata. */
  readonly sessions: ConnectorRuntimeSessionAuthoritySource;
  /** Live Mesh registry. */
  readonly mesh: ConnectorRuntimeMeshAuthoritySource;
  /** Installation or user authority that owns this provider registry. */
  readonly owner: ConnectorOwnerAuthority;
}

/** Production resolver that refuses inferred sessions and stale agent paths. */
export class CanonicalConnectorRuntimeAuthorityResolver implements ConnectorRuntimeAuthorityResolver {
  /** Construct the resolver over canonical session, Mesh, and owner state. */
  constructor(private readonly options: CanonicalConnectorRuntimeAuthorityOptions) {}

  /** Authorize one new binding from live canonical state. */
  async authorizeTurn(input: OpenConnectorTurnInput): Promise<ConnectorRuntimeAuthority> {
    const agentId = await this.resolveAgent(
      input.runtime,
      input.canonicalSessionId,
      input.agentPath
    );
    if (!agentId) throw new Error('Canonical runtime authority could not be verified.');
    return { owner: this.options.owner, agentId };
  }

  /** Recheck the exact session, runtime, and stable agent binding. */
  async revalidateTurn(
    claims: Extract<ServerPrincipalClaims, { kind: 'runtime' }>
  ): Promise<boolean> {
    if (!this.sameOwner(claims.owner)) return false;
    const agentId = await this.resolveAgent(
      claims.runtime,
      claims.canonicalSessionId,
      claims.agentPath
    );
    return agentId === claims.agentId;
  }

  private async resolveAgent(
    runtime: ConnectorRuntime,
    sessionId: string,
    agentPath: string
  ): Promise<string | undefined> {
    const [sessionRuntime, storedPath] = await Promise.all([
      this.options.sessions.resolveSessionRuntime(sessionId),
      this.options.sessions.getSessionAgentPath(sessionId),
    ]);
    if (!sessionRuntime.bound || sessionRuntime.type !== runtime || storedPath !== agentPath) {
      return undefined;
    }
    return this.options.mesh.getByPath(agentPath)?.id;
  }

  private sameOwner(owner: ConnectorOwnerAuthority): boolean {
    const expected = this.options.owner;
    return (
      expected.kind === owner.kind &&
      (expected.kind === 'user'
        ? expected.userId === (owner as Extract<ConnectorOwnerAuthority, { kind: 'user' }>).userId
        : expected.installationId ===
          (owner as Extract<ConnectorOwnerAuthority, { kind: 'local_install' }>).installationId)
    );
  }
}
