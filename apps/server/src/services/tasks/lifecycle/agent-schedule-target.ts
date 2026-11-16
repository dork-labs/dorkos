/** Resolve an agent-created schedule to a registered, safe run home. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandTilde } from '../../../lib/boundary.js';
import { isProtectedLaunchFolder } from '../../session/launch/launch-caller.js';
import type { CreateScheduledTaskRefusal } from './create-task.js';
import type { TaskLifecycleDeps } from './create-task-deps.js';

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
 * A caller DorkOS cannot identify as an agent keeps the person's placement:
 * its proposal parks for a person, and an agent-less run never stands in home
 * or the data folder (`execution/run-place-guard.ts`). An identified agent
 * with no registered folder is refused, so it learns now, not at its first run.
 *
 * @param target - The requested target, with an omitted target read as global.
 * @param caller - The calling agent's verified home, and its id when Mesh knows it,
 *   both resolved from server-owned provenance.
 * @param deps - Registry and data directory used by the create path.
 * The data folder and protected folders (`~/.ssh` and the like) are refused at
 * every level, because `guardRunPlacement` would refuse every run there: a
 * schedule that can never run is never created. Only home itself follows the
 * DOR-4136 level rule: refused below Full, allowed for a Full, unmarked turn,
 * as a person may.
 *
 * The check follows the CALLER's level, not the runner's: a Full agent filing
 * a schedule for another agent passes the home check even when that agent runs
 * below Full. That exposes nothing new, because the run is still capped at the
 * runner's own level (`capModeAtAgentLevel`), and its own chats already stand
 * in that folder.
 *
 * @param options.allowHome - Let the folder be the home folder. True only for a
 *   turn at Full autonomy, unmarked.
 */
export async function agentScheduleTarget(
  target: string,
  caller: { agentPath: string | undefined; id: string | undefined },
  deps: Pick<TaskLifecycleDeps, 'meshCore' | 'dorkHome'>,
  options: { allowHome: boolean }
): Promise<{ ok: true; target: string } | CreateScheduledTaskRefusal> {
  if (target === 'global' && caller.agentPath === undefined) return { ok: true, target };
  const resolved = target === 'global' ? caller.id : target;
  if (resolved === undefined) {
    return { ok: false, status: 403, code: 'not_your_agent', error: UNKNOWN_HOME };
  }
  const folder = deps.meshCore?.getProjectPath(resolved);
  // Keep the create path's existing missing-registry and missing-agent errors.
  if (!folder) return { ok: true, target: resolved };
  return (await isSafeRunHome(folder, deps.dorkHome, options.allowHome))
    ? { ok: true, target: resolved }
    : { ok: false, status: 403, code: 'PROTECTED_FOLDER', error: PROTECTED_HOME };
}

/**
 * Whether a folder is an existing directory that is not the data folder or protected, and is
 * below home (or home itself, when `allowHome`). Never above home.
 */
async function isSafeRunHome(
  folder: string,
  dorkHome: string,
  allowHome: boolean
): Promise<boolean> {
  try {
    const real = await fs.realpath(folder);
    const home = await fs.realpath(expandTilde('~'));
    const aboveHome = path.relative(real, home);
    const atOrAboveHome =
      aboveHome !== '..' && !aboveHome.startsWith(`..${path.sep}`) && !path.isAbsolute(aboveHome);
    const refusedHome = atOrAboveHome && !(allowHome && aboveHome === '');
    if (refusedHome || real === (await realOr(dorkHome)) || isProtectedLaunchFolder(real, real)) {
      return false;
    }
    return (await fs.stat(real)).isDirectory();
  } catch {
    return false;
  }
}

/** A folder's real path, or its resolved spelling when it does not exist yet. */
async function realOr(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}
