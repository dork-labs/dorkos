/**
 * The agent's own skills in the `/` menu when it works outside its home
 * (DOR-5250).
 *
 * A runtime's menu lists what the working folder holds. An agent sent to work
 * in a project folder lost its own skills from the menu, though its prompt still
 * lists them (`home-skills-block.ts`). This adds them, read the way the Codex
 * menu reads a folder (`scanSkillCommands`: `.agents/skills`, honouring
 * `user-invocable: false`). A name the working folder already has wins, so a
 * project's own `/release` is never replaced by the agent's.
 *
 * @module services/runtimes/shared/home-skill-commands
 */
import type { CommandEntry } from '@dorkos/shared/types';
import { scanSkillCommands } from '../codex/scan-skill-commands.js';
import { homeOutside } from './home-skills-block.js';

/**
 * The working folder's commands, plus the home's skills whose names it does
 * not already have, sorted by command. Nothing is added inside the home, for a
 * session with no agent, or for a folder that is another agent's
 * ({@link homeOutside}).
 *
 * @param commands - The working folder's commands.
 * @param cwd - The session's working folder.
 * @param agentPath - The session's agent, as the server recorded it.
 */
export function withHomeSkillCommands(
  commands: CommandEntry[],
  cwd: string,
  agentPath: string | undefined
): CommandEntry[] {
  const home = homeOutside(cwd, agentPath);
  if (!home) return commands;
  const taken = new Set(commands.map((entry) => entry.fullCommand));
  const added = scanSkillCommands(home).filter((entry) => !taken.has(entry.fullCommand));
  if (added.length === 0) return commands;
  return [...commands, ...added].sort((a, b) => a.fullCommand.localeCompare(b.fullCommand));
}

/**
 * A folder's skills as `/` commands (`scanSkillCommands`), plus the agent's own
 * when the folder is outside its home: the Codex menu. Empty with no folder.
 *
 * @param cwd - The session's working folder, if known.
 * @param agentPath - The session's agent, as the server recorded it.
 */
export function skillCommandsFor(cwd: string | undefined, agentPath?: string): CommandEntry[] {
  return cwd ? withHomeSkillCommands(scanSkillCommands(cwd), cwd, agentPath) : [];
}
