import { registerRestoredAgents } from '../services/marketplace/restored-agents.js';
import {
  retryInFlightTargetsLater,
  type InstallSweepSummary,
} from '../services/marketplace/recovery/backup-janitor.js';
import type { MeshCore } from '@dorkos/mesh';
import { snapshotDaily, type Db } from '@dorkos/db';
import type { ConnectorRuntimeToolConsumer } from '../services/runtimes/connector-tools.js';
import type { LegacySweepSummary } from '../services/marketplace/lib/integrity/legacy-record-sweep.js';
import type { AgentMcpOAuthService } from '../services/mesh/agent-mcp-oauth-service.js';
import type { AgentMcpServerService } from '../services/mesh/agent-mcp-server-service.js';
import { logger, logError } from '../lib/logger.js';

/** Recognize the unchanged optional connector tool-consumer surface. */
export function connectorRuntimeConsumer(
  runtime: unknown
): ConnectorRuntimeToolConsumer | undefined {
  if (
    typeof runtime === 'object' &&
    runtime !== null &&
    'setConnectorRuntimeTools' in runtime &&
    typeof (runtime as { setConnectorRuntimeTools?: unknown }).setConnectorRuntimeTools ===
      'function'
  ) {
    return runtime as ConnectorRuntimeToolConsumer;
  }
  return undefined;
}

/**
 * Every registered agent that has a project on disk, as the legacy migration
 * wants them.
 *
 * Lives here rather than inline because the filter is the interesting part: an
 * agent with no resolvable project path has no `.dork/tasks/` to migrate and no
 * `.agents/skills/` to migrate into, and asking about it would only produce a
 * pair of ENOENTs.
 *
 * @param meshCore - The registry, absent when Mesh is switched off.
 */
export function registeredAgentRoots(
  meshCore: MeshCore | undefined
): { agentId: string; projectPath: string }[] {
  if (!meshCore) return [];
  return meshCore.list().flatMap((agent) => {
    const projectPath = meshCore.getProjectPath(agent.id);
    return projectPath ? [{ agentId: agent.id, projectPath }] : [];
  });
}

/**
 * Log what the legacy record sweep did, when it did anything.
 *
 * @param summary - The sweep's outcome lists.
 */
export function logLegacySweep(summary: LegacySweepSummary): void {
  const { rebuilt, mismatch, noSource, fetchFailed } = summary;
  if (rebuilt.length + mismatch.length + noSource.length + fetchFailed.length === 0) return;
  logger.info(
    `[Marketplace] Records for packages an older DorkOS installed: ${rebuilt.length} rebuilt, ${mismatch.length} changed since install, ${noSource.length} installed from a local folder, ${fetchFailed.length} to retry`
  );
}

/**
 * Re-prime the managed-MCP OAuth token cache from disk on boot (DOR-942): for
 * every registered agent's enabled http/sse servers, hand the OAuth engine the
 * `(agentId, serverName, serverUrl)` targets so it can load any stored token and
 * schedule its background refresh. A server with no stored token is skipped by
 * the engine (stays needs-auth). Best-effort per agent — an unreadable manifest
 * for one agent never blocks warming the rest.
 *
 * @param oauth - The managed-MCP OAuth engine to warm.
 * @param service - The managed-server service that lists each agent's servers.
 * @param mesh - The mesh core whose registry enumerates the agents.
 */
export async function warmMcpOAuthTokens(
  oauth: AgentMcpOAuthService,
  service: AgentMcpServerService,
  mesh: MeshCore
): Promise<void> {
  const targets: { agentId: string; serverName: string; serverUrl: string }[] = [];
  for (const agent of mesh.agentRegistry.list()) {
    try {
      const servers = await service.list(agent.id);
      for (const s of servers) {
        if (s.enabled && s.connection.transport !== 'stdio') {
          targets.push({ agentId: agent.id, serverName: s.name, serverUrl: s.connection.url });
        }
      }
    } catch {
      // Unreadable/absent manifest for one agent: skip it, warm the others.
    }
  }
  await oauth.warm(targets);
}

/**
 * Take the day's snapshot of `dork.db`, if today has not had one yet.
 *
 * Best-effort by design, and that is the difference from the pre-migration
 * snapshot: nothing irreversible happens next, so a full disk should cost a
 * warning in the log rather than a server that will not start.
 *
 * @param db - The consolidated database.
 * @param backupsDir - `<dorkHome>/backups`.
 */
export function takeDailySnapshot(db: Db, backupsDir: string): void {
  try {
    const written = snapshotDaily(db, { dir: backupsDir });
    if (written) logger.info(`[DB] Daily snapshot written to ${written}`);
  } catch (err) {
    logger.warn('[DB] Daily snapshot failed — your data is fine, the backup is not', logError(err));
  }
}

/** Register restored agents with the current mesh and report completed install sweeps. */
export function logInstallSweepWithCurrentMesh(
  scope: string,
  summary: InstallSweepSummary,
  currentMesh: () => MeshCore | undefined
): void {
  registerRestoredAgents(summary.restoredAgentRoots, currentMesh());
  const { settled, kept, discarded, inFlightTargets } = summary;
  if (settled + kept + discarded + inFlightTargets.length > 0) {
    logger.info(
      `[Marketplace] Settled interrupted ${scope}: ${settled} settled, ${kept} kept, ${discarded} leftovers removed, ${inFlightTargets.length} left to another running DorkOS`
    );
  }
  // A target left to another process is looked at once more when every record
  // there has aged past the point where its owner matters.
  retryInFlightTargetsLater(inFlightTargets, logger, (retry) =>
    logInstallSweepWithCurrentMesh(
      `${scope} (retry)`,
      { ...retry, inFlightTargets: [] },
      currentMesh
    )
  );
}
