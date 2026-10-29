/**
 * Startup step: scan every agent's folder for secret-looking file names once,
 * in the background, then again whenever an agent arrives or changes
 * (DOR-3292). Every arrival path (create, register, `mesh_register`, a
 * discovery adopt) writes the agent's identity, which is what Mesh's change
 * event reports.
 *
 * @module startup/steps/secret-file-scan
 */
import { logger } from '../../lib/logger.js';
import { notify } from '../../services/notifications/notification-service.js';
import {
  SecretFileScanService,
  setSecretFileScanService,
  type ScannedAgent,
} from '../../services/core/secret-file-scan/secret-file-scan-service.js';
import type { ServerRefs } from '../server-refs.js';

/**
 * Wire the scan service and start it. Never throws, and never holds startup up.
 *
 * @param refs - The server's live references; needs Mesh.
 */
export function startSecretFileScanOnBoot(refs: ServerRefs): void {
  const mesh = refs.meshCore;
  if (!mesh) return;
  const service = new SecretFileScanService({
    notify: (payload) => notify('agent.secret_files', payload),
    logger,
  });
  setSecretFileScanService(service);
  const agentOf = (a: { id: string; name: string; displayName?: string; projectPath: string }) =>
    ({ id: a.id, name: a.displayName ?? a.name, folders: [a.projectPath] }) satisfies ScannedAgent;

  mesh.onAgentsChanged((change) => {
    if (change.kind === 'removed' || !change.projectPath) return;
    void service.scanAgent({
      id: change.agentId,
      name: change.displayName ?? change.name ?? change.agentId,
      folders: [change.projectPath],
    });
  });

  // One agent at a time, so a big install doesn't spike the disk at boot.
  void (async () => {
    try {
      for (const agent of mesh.listWithPaths()) await service.scanAgent(agentOf(agent));
    } catch (err) {
      logger.warn('[SecretFiles] The boot scan stopped early', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
