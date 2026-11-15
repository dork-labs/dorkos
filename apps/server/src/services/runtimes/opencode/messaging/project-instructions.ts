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
 * project's top is read. A symlink or anything but a regular file is never
 * read, and the text is cut to a fixed budget (`shared/project-files/instruction-files.ts`).
 *
 * @module services/runtimes/opencode/messaging/project-instructions
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { joinInstructionFiles } from '../../shared/project-files/instruction-files.js';

/**
 * The folders from the project's top (the nearest folder holding `.git`) down
 * to `dir`, outermost first; outside a repo, `dir` alone. The same walk counts
 * the project's withheld add-ons (`withheld-project-addons.ts`).
 *
 * @param dir - The session's folder.
 */
export function openCodeProjectChain(dir: string): string[] {
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
  return joinInstructionFiles(
    openCodeProjectChain(directory).map((dir) => path.join(dir, 'AGENTS.md'))
  );
}
