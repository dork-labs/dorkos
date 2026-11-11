/** Resolve an agent-created schedule to a registered, safe run home. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandTilde } from '../../../lib/boundary.js';
import { isProtectedLaunchFolder } from '../../session/launch/launch-caller.js';
import type { CreateScheduledTaskRefusal, TaskLifecycleDeps } from './create-task.js';

/** A schedule without a known agent cannot inherit the server's working folder. */
const UNKNOWN_HOME =
  'Schedules use your own folder by default. Choose an agent with a project folder.';
/** Refuse before writing either the file or its derived row. */
const PROTECTED_HOME =
  'Schedules use your own folder by default. Give this agent a separate project folder.';

/**
 * Bind a global request to its verified caller and check the target's home.
 * The caller computes approval and cross-agent rules before this substitution,
 * so choosing a run folder never grants permission to arm a global proposal.
 *
 * @param target - The requested target, with an omitted target read as global.
 * @param callerId - The caller resolved from server-owned provenance.
 * @param deps - Registry and data directory used by the create path.
 */
export async function agentScheduleTarget(
  target: string,
  callerId: string | undefined,
  deps: Pick<TaskLifecycleDeps, 'meshCore' | 'dorkHome'>
): Promise<{ ok: true; target: string } | CreateScheduledTaskRefusal> {
  const resolved = target === 'global' ? callerId : target;
  if (resolved === undefined) {
    return { ok: false, status: 403, code: 'not_your_agent', error: UNKNOWN_HOME };
  }
  const folder = deps.meshCore?.getProjectPath(resolved);
  // Keep the create path's existing missing-registry and missing-agent errors.
  if (!folder) return { ok: true, target: resolved };
  try {
    const real = await fs.realpath(folder);
    const home = await fs.realpath(expandTilde('~'));
    const aboveHome = path.relative(real, home);
    if (
      (aboveHome !== '..' &&
        !aboveHome.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(aboveHome)) ||
      real === (await fs.realpath(deps.dorkHome)) ||
      isProtectedLaunchFolder(real, real)
    ) {
      return { ok: false, status: 403, code: 'PROTECTED_FOLDER', error: PROTECTED_HOME };
    }
    if (!(await fs.stat(real)).isDirectory()) throw new Error('Not a folder');
  } catch {
    return { ok: false, status: 403, code: 'PROTECTED_FOLDER', error: PROTECTED_HOME };
  }
  return { ok: true, target: resolved };
}
