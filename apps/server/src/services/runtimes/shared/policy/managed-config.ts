/** Share Claude Code's content pin with every managed-server launch. */
import { readHomeManifest } from '../../../core/agent-identity/index.js';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { resolveFolderConfigForLaunch } from '../../claude-code/folder-settings/launch-folder-config.js';

/** Hold changed manifests below Full without recording a Full load as approved. */
export async function managedConfigHeld(
  home: string | undefined,
  cwd: string,
  full: boolean,
  mesh?: AgentRegistryPort
): Promise<boolean> {
  if (!home) return false;
  let agent = mesh?.getByPath(home);
  if (!agent) {
    const manifest = await readHomeManifest(home);
    if (!manifest?.id) return true;
    agent = { id: manifest.id, name: manifest.name };
  }
  const decision = await resolveFolderConfigForLaunch({
    home,
    cwd,
    full,
    agent: agent ? { id: agent.id, name: agent.displayName ?? agent.name ?? agent.id } : undefined,
  });
  return decision.held.includes('manifest');
}
