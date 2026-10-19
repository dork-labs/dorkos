/**
 * Whether an agent still has notes waiting in Claude Code's own memory folder.
 *
 * DorkOS switches Claude Code's auto-memory off for an agent's turns so its
 * DorkOS memory is its only memory (ADR `261017-153539`). Switching it off
 * before the old notes are copied over would hide them from the agent, so the
 * switch waits for this to say the folder is empty or has been moved: it holds
 * no notes, or the migration left its "moved" marker in it.
 *
 * @module services/runtimes/claude-code/claude-memory-folder
 */
import { readdirSync } from 'fs';
import path from 'path';

import { MOVED_MARKER_FILE } from '@dorkos/memory';

import { projectSlug } from './sessions/project-slug.js';

/**
 * True when Claude Code's memory folder for this agent, in this account, still
 * holds notes nobody has copied into DorkOS memory yet.
 *
 * A folder that cannot be read counts as empty: the cost of being wrong is
 * Claude Code's memory staying off for an agent whose notes the migration's
 * report will still list, never notes silently shown twice.
 *
 * @param accountRoot - The Claude account folder this turn launches with.
 * @param agentPath - The agent's registered home.
 */
export function hasUnmovedClaudeMemory(accountRoot: string, agentPath: string): boolean {
  let files: string[];
  try {
    files = readdirSync(path.join(accountRoot, 'projects', projectSlug(agentPath), 'memory'));
  } catch {
    return false;
  }
  if (files.includes(MOVED_MARKER_FILE)) return false;
  return files.some((file) => file.endsWith('.md'));
}
