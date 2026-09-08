/**
 * Subagent half of the source inventory — the definitions under
 * `.claude/agents`, which no version of the engine had ever looked at (XA-01).
 *
 * The walk is recursive: this repository keeps two of its seven subagents in
 * subdirectories (`.claude/agents/react/…`, `.claude/agents/typescript/…`), and
 * a walk that stopped at the top level would call that five.
 *
 * A subagent's name is its path below `.claude/agents` without the `.md`, which
 * is the same rule the commands inventory uses and the same one Claude Code's
 * own namespacing implies.
 *
 * @module inventory/agents
 */
import { join } from 'node:path';
import { listMarkdownFiles } from './read.js';
import type { AgentInventoryEntry, UnreadableSource } from './types.js';

/** The repo-relative directory Claude Code reads subagent definitions from. */
export const CLAUDE_AGENTS_DIR = '.claude/agents';

/**
 * Inventory every subagent definition under `.claude/agents`.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the subagent definitions and any directory that could not be listed
 *   (a file sitting where `.claude/agents` should be, most of all).
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
  return {
    agents: files.map((file) => ({
      kind: 'agent' as const,
      name: file.name,
      source: file.source,
      provenance: 'authored' as const,
    })),
    unreadable,
  };
}
