/**
 * The facts `cloudAgentSupport` (`@dorkos/marketplace`) judges, read for a
 * staged package: its manifest, its permission preview, and the runtime its
 * own `.dork/agent.json` names when it is an agent package. The install
 * dialog shows the answer, and an agent computer refuses an install the
 * answer says no to (`installer/install-dispatch.ts`).
 *
 * @module services/marketplace/lib/cloud-agent-facts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cloudAgentSupport,
  type CloudAgentSupport,
  type MarketplacePackageManifest,
} from '@dorkos/marketplace';
import { CONVENTION_DIR } from '@dorkos/shared/convention-files';
import type { PermissionPreview } from '../types.js';

/**
 * The runtime a staged agent package's own `.dork/agent.json` names, or
 * `undefined` when it names none, has none, or it cannot be read. Read raw:
 * the manifest schema fills in a default runtime, which would make a package
 * that left the choice open look as though it had made one.
 *
 * @param packagePath - The staged package's directory.
 */
export async function packageAgentRuntime(packagePath: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(packagePath, CONVENTION_DIR, 'agent.json'), 'utf8')
    ) as unknown;
    const runtime = (raw as { runtime?: unknown } | null)?.runtime;
    return typeof runtime === 'string' && runtime.trim() !== '' ? runtime : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a staged package works on a cloud agent.
 *
 * @param packagePath - The staged package's directory.
 * @param manifest - Its validated manifest.
 * @param preview - Its permission preview.
 * @param chosenRuntime - The runtime a person picked for the agent it creates,
 *   which wins over the package's own.
 */
export async function stagedCloudAgentSupport(
  packagePath: string,
  manifest: Pick<MarketplacePackageManifest, 'type'> & { adapterType?: string },
  preview: Pick<
    PermissionPreview,
    'hooks' | 'unreadableHooks' | 'monitors' | 'lspServers' | 'mcpServers'
  >,
  chosenRuntime?: string
): Promise<CloudAgentSupport> {
  const agentRuntime =
    manifest.type === 'agent'
      ? (chosenRuntime ?? (await packageAgentRuntime(packagePath)))
      : undefined;
  return cloudAgentSupport({
    type: manifest.type,
    ...(manifest.adapterType !== undefined && { adapterType: manifest.adapterType }),
    ...(agentRuntime !== undefined && { agentRuntime }),
    hooks: preview.hooks,
    unreadableHooks: preview.unreadableHooks,
    monitors: preview.monitors,
    lspServers: preview.lspServers,
    mcpServers: preview.mcpServers,
  });
}
