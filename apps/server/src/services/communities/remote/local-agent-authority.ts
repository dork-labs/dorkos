/**
 * Reads the current on-disk Mesh manifest before remote Community work may use
 * a cached local agent enrollment.
 *
 * @module services/communities/remote/local-agent-authority
 */
import { readManifest, type MeshCore } from '@dorkos/mesh';

/** The narrow Mesh lookup surface needed to verify current local ownership. */
export type CurrentMeshAgentLookup = Pick<MeshCore, 'get' | 'getProjectPath'>;

/**
 * Return true only when the current registry path still holds this exact manifest.
 *
 * The Mesh registry is deliberately a recoverable cache and can retain an
 * unreachable row through its grace period. Remote output is more restrictive:
 * a missing, unreadable, invalid, moved, or replacement manifest cannot keep a
 * durable enrollment authorized to upload or post.
 */
export async function isCurrentLocalMeshAgent(
  mesh: CurrentMeshAgentLookup,
  localAgentId: string
): Promise<boolean> {
  const registered = mesh.get(localAgentId);
  const projectPath = mesh.getProjectPath(localAgentId);
  if (!registered || registered.id !== localAgentId || !projectPath) return false;
  const manifest = await readManifest(projectPath);
  return manifest?.id === localAgentId;
}
