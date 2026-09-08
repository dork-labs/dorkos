/**
 * Subagent half of the source inventory — the definitions under
 * `.claude/agents`, which no version of the engine had ever looked at (XA-01).
 *
 * The walk is recursive: this repository keeps two of its seven subagents in
 * subdirectories (`.claude/agents/react/…`, `.claude/agents/typescript/…`), and
 * a walk that stopped at the top level would call that five.
 *
 * **The name is the frontmatter `name`, not the path.** Claude Code's subagents
 * page is explicit: "The subdirectory path doesn't affect how a subagent is
 * identified or invoked, because identity comes only from the `name` frontmatter
 * field" (https://code.claude.com/docs/en/sub-agents, fetched 2026-09-08), and
 * names must be unique across the whole tree. Reporting a nested definition as
 * `react/tanstack` named it something nobody can type at it. The `source` stays
 * the path, because that is the file a person opens.
 *
 * A definition whose frontmatter declares no usable `name` is still inventoried
 * — the file is there and Claude Code reads the directory — under its file stem,
 * and the missing identity is recorded as an {@link UnreadableSource} so the
 * guess is said out loud rather than presented as fact. Chosen over a plan
 * warning so it sits beside every other read failure in one list.
 *
 * @module inventory/agents
 */
import { join } from 'node:path';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { listMarkdownFiles, readTextFile } from './read.js';
import type { AgentInventoryEntry, UnreadableSource } from './types.js';

/** The repo-relative directory Claude Code reads subagent definitions from. */
export const CLAUDE_AGENTS_DIR = '.claude/agents';

/** The file stem of a repo-relative markdown path — the fallback identity. */
function stemOf(source: string): string {
  return (source.split('/').pop() ?? source).slice(0, -'.md'.length);
}

/**
 * Inventory every subagent definition under `.claude/agents`.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the subagent definitions and every file or directory that could not
 *   be read — a file sitting where `.claude/agents` should be, a link whose
 *   target moved, or a definition that declares no name.
 */
export function inventoryAgents(repoRoot: string): {
  agents: AgentInventoryEntry[];
  unreadable: UnreadableSource[];
} {
  const { files, unreadable } = listMarkdownFiles(
    join(repoRoot, CLAUDE_AGENTS_DIR),
    CLAUDE_AGENTS_DIR,
    'agent',
    { recursive: true }
  );

  const agents: AgentInventoryEntry[] = [];
  for (const file of files) {
    const read = readTextFile(join(repoRoot, file.source), file.source, 'agent');
    if (read.text === undefined) {
      if (read.unreadable) unreadable.push(read.unreadable);
      continue;
    }
    const frontmatter = readRawFrontmatter(read.text);
    const declared = frontmatter?.data.name;
    const name =
      typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : undefined;
    if (name === undefined) {
      unreadable.push({
        kind: 'agent',
        source: file.source,
        reason: `${file.source} declares no frontmatter "name", which is the only identity Claude Code invokes a subagent by — it is listed under its file name instead`,
      });
    }
    agents.push({
      kind: 'agent',
      name: name ?? stemOf(file.source),
      source: file.source,
      provenance: 'authored',
    });
  }
  // Sorted by the identity a person types, not by the path they happen to sit
  // at: the path is not the name, and two subdirectories are an organizing
  // choice Claude Code ignores. `source` breaks a tie so the order is stable.
  agents.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  return { agents, unreadable };
}
