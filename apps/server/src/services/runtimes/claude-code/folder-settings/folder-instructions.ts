/**
 * The `CLAUDE.md` text a held launch still hands the model (DOR-3068 M1).
 *
 * While an agent's changed hooks are held, its launch leaves out the `project`
 * and `local` settings sources: that is the one switch that stops every
 * setting that runs code (`env`, the helper commands, plugins), and every
 * skill, command and subagent whose frontmatter widens what runs, not only the
 * hooks `disableAllHooks` covers. Those sources also carry the folder's
 * `CLAUDE.md`, so this reads the same files and the launch passes their text
 * in the system prompt instead.
 *
 * What it reads, outermost first, as Claude Code orders them: `CLAUDE.md` in
 * every folder above the home, then `CLAUDE.md` and `.claude/CLAUDE.md` in the
 * home and each folder down to the turn's own. `CLAUDE.local.md` is the local
 * source and stays out. `@` imports are not followed: their text does not
 * reach the model while the hold lasts.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-instructions
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The largest file read. A real one is a few kilobytes. */
const MAX_FILE_BYTES = 64 * 1024;

/** The most text passed in all, so a planted file can't flood the prompt. */
const MAX_TOTAL_CHARS = 128 * 1024;

/** A regular file's text, or `undefined` when it is absent, too big or unreadable. */
function readInstructions(file: string): string | undefined {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Every folder from the filesystem root down to `dir`, outermost first. */
function chainTo(dir: string): string[] {
  const chain: string[] = [];
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    chain.unshift(at);
    if (path.dirname(at) === at) return chain;
  }
}

/**
 * The text of the instruction files a held launch would otherwise lose, each
 * headed by its path, or `undefined` when there are none.
 *
 * @param cwd - The turn's working folder (the home or a folder inside it).
 * @param home - The registered agent home.
 */
export function folderInstructions(cwd: string, home: string): string | undefined {
  const resolvedHome = path.resolve(home);
  const files: string[] = [];
  for (const dir of chainTo(cwd)) {
    files.push(path.join(dir, 'CLAUDE.md'));
    const inHome = dir === resolvedHome || dir.startsWith(`${resolvedHome}${path.sep}`);
    if (inHome) files.push(path.join(dir, '.claude', 'CLAUDE.md'));
  }
  const parts: string[] = [];
  let total = 0;
  for (const file of files) {
    const text = readInstructions(file);
    if (text === undefined || text.trim() === '') continue;
    const part = `Contents of ${file}:\n\n${text}`;
    if (total + part.length > MAX_TOTAL_CHARS) break;
    parts.push(part);
    total += part.length;
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
