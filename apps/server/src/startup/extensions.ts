/**
 * Start the extension system at boot: scan every known project's extensions,
 * follow the project registry for new ones, run them, ask in the inbox about
 * the ones waiting for a person, and close the open decisions of extensions
 * that are no longer installed. Non-fatal: the server runs without extensions.
 *
 * @module startup/extensions
 */
import { logger } from '../lib/logger.js';
import { broadcastExtensionReloaded } from '../routes/extensions.js';
import { startExtensionApprovalQueue } from '../services/extensions/extension-approval-queue.js';
import { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { CoreExtensionInfo } from '../services/extensions/extension-enable-resolution.js';
import { getExtensionInbox } from '../services/extensions/inbox/extension-inbox.js';
import { knownProjectRootsForExtensions } from '../services/projects/extension-scan-roots.js';
import { projectRegistry } from '../services/projects/project-registry.js';

/**
 * Start the extension system.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param coreExtensions - The core extensions staged for this boot.
 * @param initialCwd - The folder whose extensions run first, or `null`.
 * @param agentHomes - Every registered agent's folder, read at each scan, so
 *   an agent's mini apps (`<agentHome>/.dork/extensions`) show whatever
 *   folder is active (DOR-3068).
 * @returns The running manager, or `undefined` when it could not start.
 */
export async function startExtensions(
  dorkHome: string,
  coreExtensions: CoreExtensionInfo[],
  initialCwd: string | null,
  agentHomes: () => readonly string[] = () => []
): Promise<ExtensionManager | undefined> {
  try {
    const manager = new ExtensionManager(dorkHome, coreExtensions);
    // Scan every known project's extensions, not only this folder's, and
    // re-scan when a project is added, so which copy runs no longer depends on
    // where the server started (spec `flow-multiproject` §9.2). Only roots core
    // saw itself: never one only an extension reported (§6.1).
    manager.followProjects(
      {
        roots: (cwd) => knownProjectRootsForExtensions(projectRegistry, dorkHome, cwd, agentHomes),
        onChange: (listener) => projectRegistry.onChange(listener),
      },
      { announce: (ids) => broadcastExtensionReloaded(ids) }
    );
    await manager.initialize(initialCwd);
    // Every extension waiting for a person to let it run asks in the Activity
    // inbox, and keeps asking as installs, updates and answers change the set
    // (DOR-2517). Follows the manager for the life of the process.
    startExtensionApprovalQueue(manager);
    // An extension that is no longer installed at all has nobody left to
    // explain its open decisions: they close as "no longer needed", quietly.
    getExtensionInbox()?.cancelUndiscovered(
      new Set(manager.listRecords().map((record) => record.id))
    );
    logger.info('[Extensions] Extension system initialized');
    return manager;
  } catch (err) {
    // Extension failure is non-fatal: server continues without extensions
    logger.error('[Extensions] Failed to initialize extension system', err);
    return undefined;
  }
}
