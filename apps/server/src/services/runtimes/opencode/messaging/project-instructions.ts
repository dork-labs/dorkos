/**
 * A project's `AGENTS.md` text, passed by DorkOS (DOR-4394).
 *
 * The sidecar runs with `OPENCODE_DISABLE_PROJECT_CONFIG`, so a cloned
 * project's own config, plugins, tools and MCP servers never load into the
 * process every OpenCode chat shares. That switch also stops OpenCode reading
 * the project's `AGENTS.md`, so DorkOS reads the same files and passes their
 * text after its own instructions, never above them, the way the Claude
 * runtime passes a held folder's `CLAUDE.md` (`folder-instructions.ts`).
 *
 * What it reads, outermost first, as OpenCode does: `AGENTS.md` in each folder
 * from the project's top (the nearest folder holding `.git`) down to the
 * session's own. Outside a repo, only the session's folder. Nothing above the
 * project's top is read.
 *
 * @module services/runtimes/opencode/messaging/project-instructions
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
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

/** The folders from the project's top down to `dir`, outermost first. */
function projectChain(dir: string): string[] {
  const chain: string[] = [];
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    chain.unshift(at);
    if (existsSync(path.join(at, '.git'))) return chain;
    if (path.dirname(at) === at) return [path.resolve(dir)];
  }
}

/**
 * The project's `AGENTS.md` text, each file headed by its path, or
 * `undefined` when there is none.
 *
 * @param directory - The session's folder, as OpenCode stores it.
 */
export function openCodeProjectInstructions(directory: string): string | undefined {
  const parts: string[] = [];
  let total = 0;
  for (const dir of projectChain(directory)) {
    const file = path.join(dir, 'AGENTS.md');
    const text = readInstructions(file);
    if (text === undefined || text.trim() === '') continue;
    const part = `Contents of ${file}:\n\n${text}`;
    if (total + part.length > MAX_TOTAL_CHARS) break;
    parts.push(part);
    total += part.length;
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
