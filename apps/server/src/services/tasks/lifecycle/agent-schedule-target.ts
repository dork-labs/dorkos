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
 * A caller DorkOS cannot identify as an agent keeps the person's placement:
 * its proposal parks for a person, and an agent-less run never stands in home
 * or the data folder (`execution/run-place-guard.ts`). An identified agent
 * with no registered folder is refused, so it learns now, not at its first run.
 *
 * @param target - The requested target, with an omitted target read as global.
 * @param caller - The calling agent's verified home, and its id when Mesh knows it,
 *   both resolved from server-owned provenance.
 * @param deps - Registry and data directory used by the create path.
 * @param options.checkFolder - Refuse a folder that is home, the data folder or
 *   protected. False only for a turn at Full autonomy, unmarked, which may
 *   file there as a person can (the DOR-4136 level rule).
 */
export async function agentScheduleTarget(
  target: string,
  caller: { agentPath: string | undefined; id: string | undefined },
  deps: Pick<TaskLifecycleDeps, 'meshCore' | 'dorkHome'>,
  options: { checkFolder: boolean }
): Promise<{ ok: true; target: string } | CreateScheduledTaskRefusal> {
  if (target === 'global' && caller.agentPath === undefined) return { ok: true, target };
  const resolved = target === 'global' ? caller.id : target;
  if (resolved === undefined) {
    return { ok: false, status: 403, code: 'not_your_agent', error: UNKNOWN_HOME };
  }
  if (!options.checkFolder) return { ok: true, target: resolved };
  const folder = deps.meshCore?.getProjectPath(resolved);
  // Keep the create path's existing missing-registry and missing-agent errors.
  if (!folder) return { ok: true, target: resolved };
  return (await isSafeRunHome(folder, deps.dorkHome))
    ? { ok: true, target: resolved }
    : { ok: false, status: 403, code: 'PROTECTED_FOLDER', error: PROTECTED_HOME };
}

/** Whether a folder is an existing directory below home that is not the data folder or protected. */
async function isSafeRunHome(folder: string, dorkHome: string): Promise<boolean> {
  try {
    const real = await fs.realpath(folder);
    const home = await fs.realpath(expandTilde('~'));
    const aboveHome = path.relative(real, home);
    const atOrAboveHome =
      aboveHome !== '..' && !aboveHome.startsWith(`..${path.sep}`) && !path.isAbsolute(aboveHome);
    if (atOrAboveHome || real === (await realOr(dorkHome)) || isProtectedLaunchFolder(real, real)) {
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
