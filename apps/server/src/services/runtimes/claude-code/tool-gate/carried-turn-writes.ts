/**
 * The calls a turn that carries an outsider's words on puts to a person (DOR-3390).
 *
 * Such a turn runs at its agent's own level, and until its shell runs sandboxed only Bash asks.
 * Two kinds of file edit would get around that, so they ask too:
 *
 * - **Files git runs programs from.** A `.git` folder (its `config` names `diff.external`,
 *   `core.fsmonitor`, hooks), `.gitattributes` (a `textconv` driver) and `.gitmodules`. An edit
 *   there turns the next `git diff`, by this turn or by the person, into any command at all.
 *   Every `git` command asks in such a turn for the same reason.
 * - **Who the agent is.** Anything under a `.dork` folder: `SOUL.md`, `NOPE.md`, `HEARTBEAT.md`,
 *   `MEMORY.md`. Every later turn reads them with no mark on them, so an edit would launder the
 *   outside words into the agent itself. `update_agent` and `memory_write` already refuse this in
 *   a marked turn; a direct edit must not be the way around them.
 *
 * Paths are read where they really are, symlinks followed, so a link to `.git/config` asks too.
 *
 * @module services/runtimes/claude-code/tool-gate/carried-turn-writes
 */
import path from 'node:path';
import { realLocation } from './held-turn-reads.js';

/** File tools that write, and the input field each names its path in. */
const FILE_WRITE_PATHS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Folder names an edit anywhere below asks about. */
const GUARDED_FOLDERS: ReadonlySet<string> = new Set(['.git', '.dork']);

/** File names an edit asks about wherever they are. */
const GUARDED_FILES: ReadonlySet<string> = new Set(['.gitattributes', '.gitmodules']);

/** Whether one path, as given and where it really is, names a guarded folder or file. */
function guarded(target: string): boolean {
  return [target, realLocation(target)].some((where) => {
    const parts = where.split(path.sep);
    return (
      parts.slice(0, -1).some((part) => GUARDED_FOLDERS.has(part)) ||
      GUARDED_FILES.has(parts.at(-1) ?? '') ||
      GUARDED_FOLDERS.has(parts.at(-1) ?? '')
    );
  });
}

/**
 * Whether a file tool's call in a carried turn writes somewhere a person must decide on. A write
 * tool whose path is missing or not a string asks too: there is nothing to clear it on.
 *
 * @param toolName - The tool the model called.
 * @param input - Its arguments.
 * @param cwd - The folder relative paths resolve against.
 */
export function carriedWriteAsks(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): boolean {
  const field = FILE_WRITE_PATHS[toolName];
  if (field === undefined) return false;
  const value = input[field];
  if (typeof value !== 'string' || value === '') return true;
  return guarded(path.resolve(cwd, value));
}

/**
 * Whether a shell command runs git, which reads programs to run from files a carried turn could
 * have written. The first word only, read as the plain-read check reads it (quotes stripped):
 * anything with shell syntax already asks.
 *
 * @param command - The command line.
 */
export function runsGit(command: string): boolean {
  const first = command
    .trim()
    .split(/\s+/)[0]
    ?.replace(/^(['"])(.*)\1$/, '$2');
  return first !== undefined && path.basename(first) === 'git';
}
