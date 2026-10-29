/**
 * The upgrade's half of the agent folder pin (DOR-3068 M4): on the first start
 * with the pin, record every registered agent's folder settings as they stand,
 * so a person's own agents don't all stop at once. After that, an agent with
 * no record whose home runs anything waits for a person
 * (`launch-folder-config.ts`).
 *
 * It runs once (`harness.folderConfigPinned`, operator-only, carried across a
 * config wipe), so an agent can't get a home pinned by registering it later
 * (`mesh_register`), or by wiping the config. **Residual:** anything planted in
 * a registered home before the upgrade was pinned with it.
 *
 * @module services/runtimes/claude-code/folder-settings/pin-folder-configs
 */
import { logger } from '../../../../lib/logger.js';
import {
  folderConfigsPinned,
  hasAnyFolderConfigRecord,
  hasFolderConfigRecord,
  markFolderConfigsPinned,
  recordFolderConfigApproval,
} from './folder-config-consent.js';
import { readFolderConfigParts } from './folder-config-pin.js';

/** One registered agent and its home. */
export interface RegisteredAgent {
  /** The agent's id. */
  id: string;
  /** Its home folder. */
  projectPath: string;
}

/**
 * Pin every agent in `agents`, once ever. Never throws: an agent whose home
 * can't be read is left unpinned (it waits for a person), and a list that
 * can't be read pins nothing and still counts as the one time.
 *
 * @param agents - Every registered agent, read when the step runs.
 * @returns How many agents it pinned.
 */
export async function pinRegisteredFolderConfigsOnce(
  agents: () => Promise<readonly RegisteredAgent[]>
): Promise<number> {
  if (folderConfigsPinned()) return 0;
  // Records but no marker: the marker was lost, not a first start. Pinning now
  // would trust whatever the folders hold today, so pin nothing: each agent
  // without a record waits for a person, as on first sight.
  if (hasAnyFolderConfigRecord()) {
    logger.warn('[FolderConfig] Pins exist but the upgrade marker is missing; pinning nothing');
    markFolderConfigsPinned();
    return 0;
  }
  let list: readonly RegisteredAgent[] = [];
  try {
    list = await agents();
  } catch (err) {
    logger.warn('[FolderConfig] Could not list the agents to pin; each will wait for a person', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  let pinned = 0;
  for (const agent of list) {
    try {
      if (hasFolderConfigRecord(agent.id, agent.projectPath)) continue;
      const now = readFolderConfigParts(agent.projectPath);
      if (now.unverifiable.length > 0) continue;
      recordFolderConfigApproval(
        { agentId: agent.id, home: agent.projectPath, digests: now.digests },
        'pinning the agents DorkOS already had'
      );
      pinned += 1;
    } catch {
      // Unreadable: it waits for a person like any new agent.
    }
  }
  markFolderConfigsPinned();
  logger.info('[FolderConfig] Pinned the agents DorkOS already had', { pinned });
  return pinned;
}
