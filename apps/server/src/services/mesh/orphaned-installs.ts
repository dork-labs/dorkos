/**
 * Surface marketplace installs that an agent leaves behind when it is
 * unregistered without deleting its data.
 *
 * Unregistration removes the agent from the mesh registry and deletes its
 * `.dork/agent.json`, but it does not touch `<projectPath>/.dork/plugins/`.
 * Those installs then become invisible to the cross-scope scan (which only
 * walks *registered* agents) and unmanageable from the UI. This helper logs
 * what is being orphaned at unregister time so the trail is auditable, rather
 * than letting the packages vanish silently.
 *
 * It lives on the server side (not in `@dorkos/mesh`, a leaf package) so the
 * marketplace scanner import direction stays server → package.
 *
 * @module services/mesh/orphaned-installs
 */
import type { Logger } from '@dorkos/shared/logger';
import { scanAgentLocalInstalls } from '../marketplace/installed-scanner.js';

/**
 * Log (at warn level) every marketplace package installed under an agent's
 * `.dork/plugins/` that will be orphaned by unregistering it. A no-op when the
 * agent has no local installs. Best-effort: a scan failure is swallowed so it
 * never blocks the unregister flow.
 *
 * @param opts.projectPath - The agent's project directory (resolve it *before*
 *   unregistering — the registry entry is gone by the time callbacks fire).
 * @param opts.agentLabel - Human-readable agent name for the log line.
 * @param opts.logger - Structured logger.
 */
export async function logOrphanedInstalls(opts: {
  projectPath: string;
  agentLabel: string;
  logger: Logger;
}): Promise<void> {
  try {
    const orphaned = await scanAgentLocalInstalls(opts.projectPath);
    if (orphaned.length === 0) return;
    opts.logger.warn('[Mesh] Unregistering agent orphans marketplace installs', {
      agent: opts.agentLabel,
      projectPath: opts.projectPath,
      packages: orphaned.map((p) => ({
        name: p.name,
        version: p.version,
        installPath: p.installPath,
      })),
    });
  } catch (err) {
    opts.logger.warn('[Mesh] Failed to scan for orphaned installs during unregister', {
      agent: opts.agentLabel,
      projectPath: opts.projectPath,
      err,
    });
  }
}
