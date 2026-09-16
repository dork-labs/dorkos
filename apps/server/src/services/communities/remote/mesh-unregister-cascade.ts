/**
 * Wires the authoritative local Mesh unregister signal into remote Community
 * delivery and subscription revocation.
 *
 * @module services/communities/remote/mesh-unregister-cascade
 */
import type { AuthorRegistry } from '../../rooms/author-registry.js';

/** A Mesh lifecycle source with the only callback this remote boundary needs. */
export interface MeshUnregisterSource {
  onUnregister(callback: (agentId: string, projectPath: string) => void): void;
}

/** Local remote-community lifecycle invalidated by a Mesh manifest removal. */
export interface RemoteCommunityUnregisterLifecycle {
  revokeUnregisteredAgent(localAgentId: string, formerAuthorId: string | null): void;
}

/**
 * Revoke every remote enrollment owned by a manifest as soon as Mesh unregisters it.
 *
 * The callback runs after Mesh removes its registry row. The retained author id
 * is therefore used only to halt already-running room turns; future delivery
 * resolves the manifest through Mesh again and fails closed.
 */
export function registerRemoteCommunityUnregisterCascade(
  mesh: MeshUnregisterSource,
  authors: AuthorRegistry,
  lifecycle: RemoteCommunityUnregisterLifecycle
): void {
  mesh.onUnregister((agentId) => {
    const formerAuthorId =
      authors.listActive('agent').find((author) => author.mintedForManifestId === agentId)?.id ??
      null;
    lifecycle.revokeUnregisteredAgent(agentId, formerAuthorId);
  });
}
