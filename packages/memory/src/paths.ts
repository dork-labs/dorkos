/**
 * The path jail: the one function that decides which file an agent's memory
 * lives in, and refuses every other answer.
 *
 * @module memory/paths
 */
import path from 'node:path';

import { MEMORY_DIR_NAME, MEMORY_FILE_NAME } from './constants.js';

/**
 * Refusal to resolve a memory file for a path that could reach outside the
 * agent's own directory.
 *
 * It is a hard refusal rather than a sanitised path because there is no correct
 * repair: a caller that handed over a traversing path asked for somebody else's
 * memory, and quietly writing to a third location would be the worst of the
 * available outcomes.
 */
export class MemoryPathError extends Error {
  /**
   * Build the refusal, naming the path and what is wrong with it.
   *
   * @param agentPath - The path that was rejected.
   * @param reason - Plain-language detail, e.g. `'it must be an absolute path'`.
   */
  constructor(
    readonly agentPath: string,
    readonly reason: string
  ) {
    super(`Cannot resolve a memory file for '${agentPath}': ${reason}`);
    this.name = 'MemoryPathError';
  }
}

/**
 * Resolve the one file that holds this agent's memory:
 * `<agentPath>/.dork/MEMORY.md`.
 *
 * **This is the only place a memory path is ever constructed**, and there is no
 * parameter for a file name, a sub-directory or an alternative location — the
 * tool the model calls has no path argument at all, so the sole way a write
 * could escape is a poisoned `agentPath`. Two checks close that:
 *
 * 1. The path must be **absolute**. A relative path would resolve against
 *    whatever `process.cwd()` happened to be — in a server that changes
 *    directories per session, that is a different agent's folder.
 * 2. No segment may be `..`. `path.resolve` collapses traversal *silently*, so
 *    `/agents/alpha/../beta` becomes `/agents/beta` and the result is perfectly
 *    well-formed inside a jail anchored on itself. Rejecting the segment before
 *    normalisation is what makes the jail mean "this agent's directory" rather
 *    than "wherever that string happened to point".
 *
 * The containment assertion at the end is the post-condition the callers rely
 * on, stated in code: whatever this function returns is inside
 * `<agentPath>/.dork/`.
 *
 * **The check is lexical**, exactly as `@dorkos/shared/atomic-write` keys its
 * lock lexically: it does not follow symlinks and does not fold case. An
 * operator who symlinks their own agent directory somewhere else gets what they
 * asked for; nothing an agent can write creates such a link.
 *
 * @param agentPath - The agent's own directory, absolute.
 * @throws {MemoryPathError} When the path is not absolute, is empty, or contains
 *   a `..` segment.
 */
export function resolveMemoryFile(agentPath: string): string {
  if (agentPath.trim() === '') {
    throw new MemoryPathError(agentPath, 'it must not be empty');
  }
  if (!path.isAbsolute(agentPath)) {
    throw new MemoryPathError(agentPath, 'it must be an absolute path');
  }
  if (agentPath.includes('\0')) {
    throw new MemoryPathError(agentPath, 'it must not contain a null byte');
  }
  // Split on BOTH separators rather than `path.sep`: on POSIX a backslash is a
  // legal filename character, but a Windows-shaped path reaching here is a
  // caller bug worth refusing either way, and on Windows both separators are
  // real. Checking only the platform separator would let `..\` through on Linux
  // and then behave differently the day the same code ran on Windows.
  if (agentPath.split(/[\\/]/).includes('..')) {
    throw new MemoryPathError(agentPath, "it must not contain a '..' segment");
  }

  const jail = path.join(path.resolve(agentPath), MEMORY_DIR_NAME);
  const file = path.join(jail, MEMORY_FILE_NAME);

  // Post-condition, not decoration: every caller of this function treats the
  // result as jailed, so the claim is asserted where it is made. It fires only
  // if the constants above ever gain a separator or a traversal.
  if (!file.startsWith(jail + path.sep)) {
    throw new MemoryPathError(agentPath, 'the resolved memory file would sit outside it');
  }

  return file;
}
