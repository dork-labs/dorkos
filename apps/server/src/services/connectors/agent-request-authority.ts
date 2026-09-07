/** Canonical persisted origin authority for private agent service requests. */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import type { ConnectorOwnerAuthority } from './principal/server-principal.js';
import type {
  ConnectorAgentRequestAuthorityPort,
  ConnectorAgentRequestOrigin,
} from './agent-request-service.js';

/** Canonical session reads used by the request authority adapter. */
export interface ConnectorAgentRequestSessionSource {
  /** Resolve the stored runtime and whether the session has a real binding. */
  resolveSessionRuntime(
    sessionId: string
  ): Promise<{ readonly type: string; readonly bound: boolean }>;
  /** Read the stored canonical agent path for one session. */
  getSessionAgentPath(sessionId: string): Promise<string | null>;
}

/** Canonical agent registry reads used by the request authority adapter. */
export interface ConnectorAgentRequestMeshSource {
  /** Resolve a live agent by exact canonical project path. */
  getByPath(
    projectPath: string
  ): { readonly id: string; readonly name: string; readonly displayName?: string } | undefined;
  /** Resolve one live agent by stable id. */
  get(
    agentId: string
  ): { readonly id: string; readonly name: string; readonly displayName?: string } | undefined;
  /** Return the exact live project path for one stable agent id. */
  getProjectPath(agentId: string): string | undefined;
}

/** Inputs for canonical request-origin authority. */
export interface CanonicalConnectorAgentRequestAuthorityOptions {
  readonly db: Db;
  readonly sessions: ConnectorAgentRequestSessionSource;
  readonly mesh: ConnectorAgentRequestMeshSource;
  readonly owner: ConnectorOwnerAuthority;
}

/** Production authority adapter shared by owner resolution and final dispatch preflight. */
export class CanonicalConnectorAgentRequestAuthority implements ConnectorAgentRequestAuthorityPort {
  /** Construct canonical request authority from persisted sessions and live Mesh state. */
  constructor(private readonly options: CanonicalConnectorAgentRequestAuthorityOptions) {}

  /** Recheck the complete persisted request origin without relying on the old turn lease. */
  async revalidateOrigin(origin: ConnectorAgentRequestOrigin): Promise<boolean> {
    if (!this.sameOwner(origin.owner)) return false;
    const [runtime, agentPath] = await Promise.all([
      this.options.sessions.resolveSessionRuntime(origin.sessionId),
      this.options.sessions.getSessionAgentPath(origin.sessionId),
    ]);
    return (
      runtime.bound &&
      runtime.type === origin.runtime &&
      agentPath === origin.agentPath &&
      this.options.mesh.getByPath(origin.agentPath)?.id === origin.agentId &&
      this.options.mesh.getProjectPath(origin.agentId) === origin.agentPath
    );
  }

  /** Recheck the same facts synchronously at the final runtime-effect boundary. */
  revalidateOriginSync(origin: ConnectorAgentRequestOrigin): boolean {
    if (!this.sameOwner(origin.owner)) return false;
    const session = this.options.db
      .select({ runtime: sessionMetadata.runtime, agentPath: sessionMetadata.agentPath })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, origin.sessionId))
      .get();
    return (
      session?.runtime === origin.runtime &&
      session.agentPath === origin.agentPath &&
      this.options.mesh.getByPath(origin.agentPath)?.id === origin.agentId &&
      this.options.mesh.getProjectPath(origin.agentId) === origin.agentPath
    );
  }

  /** Present only one exact agent already owned by this installation. */
  resolveAgent(owner: ConnectorOwnerAuthority, agentId: string) {
    if (!this.sameOwner(owner) || !this.options.mesh.getProjectPath(agentId)) return undefined;
    const agent = this.options.mesh.get(agentId);
    return agent ? { id: agent.id, displayName: agent.displayName ?? agent.name } : undefined;
  }

  private sameOwner(owner: ConnectorOwnerAuthority): boolean {
    const expected = this.options.owner;
    return (
      owner.kind === expected.kind &&
      (owner.kind === 'user'
        ? owner.userId === (expected as Extract<ConnectorOwnerAuthority, { kind: 'user' }>).userId
        : owner.installationId ===
          (expected as Extract<ConnectorOwnerAuthority, { kind: 'local_install' }>).installationId)
    );
  }
}
