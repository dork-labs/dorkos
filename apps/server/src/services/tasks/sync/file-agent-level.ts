/**
 * The level of the agent a schedule file belongs to, for the sync's content
 * gates (DOR-3425). Read here because it takes a file read and the gates are
 * synchronous, the same split `packageOwnershipInRoot` makes.
 *
 * Read through `resolveAgentLaunchLevel`, the function a new chat launches at
 * and the run-time bound reads (`agent-level-bound.ts`), so the mode a sync
 * writes and the level a run is held to come from one answer, and an agent's own
 * file cannot rise past what a person set.
 *
 * @module services/tasks/sync/file-agent-level
 */
import { clampModeToCeiling, levelOfMode } from '@dorkos/shared/permission-semantics';
import { isFullLevel } from '../../core/turn-power/full-autonomy.js';
import { resolveAgentLaunchLevel } from '../../session/resolution/agent-launch-level.js';
import { readAgentExecutionDefaults } from '../../session/resolution/resolve-session-defaults.js';
import { logger } from '../../../lib/logger.js';
import type { FileAgentLevel } from '../schedule-permission-clamp.js';
import { capabilitiesForTaskRuntime } from '../scheduled-run-power.js';
import type { TaskRoot } from '../skills-roots.js';

/**
 * What a file in this root may be given, or `null` for the fixed cap: a root no
 * agent owns (no agent, no lift), a level nothing set, a runtime that is not
 * registered, or a level that could not be read.
 *
 * @param root - The skills root the file was found in.
 * @param runtime - The runtime the file names, when it names one.
 */
export async function fileAgentLevel(
  root: Pick<TaskRoot, 'agentId' | 'projectPath'>,
  runtime: string | null | undefined
): Promise<FileAgentLevel | null> {
  if (!root.agentId || !root.projectPath) return null;
  try {
    const agentRuntime = runtime ?? (await readAgentExecutionDefaults(root.projectPath)).runtime;
    const capabilities = capabilitiesForTaskRuntime(agentRuntime);
    if (!capabilities) return null;
    const { mode } = await resolveAgentLaunchLevel({
      agentPath: root.projectPath,
      capabilities,
    });
    const level = levelOfMode(capabilities.permissionModes, mode);
    if (!level) return null;
    return {
      bypassAs: clampModeToCeiling(capabilities.permissionModes, 'bypassPermissions', level),
      full: isFullLevel(level),
    };
  } catch (err) {
    logger.warn('[tasks] could not read an agent’s level; its schedule file keeps the fixed cap', {
      projectPath: root.projectPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
