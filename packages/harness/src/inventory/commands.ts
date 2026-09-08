/**
 * Command half of the source inventory — the slash commands a person wrote
 * under `.claude/commands`, and none of the wrappers DorkOS generates there.
 *
 * Claude Code namespaces commands by subdirectory, so the walk is recursive and
 * a command's name is its path below `.claude/commands` without the `.md` —
 * `flow/capture`, not `capture`.
 *
 * The one exclusion is the engine's own output: an installed plugin's commands
 * are projected into `.claude/commands/<pkg>/` as generated wrappers, each
 * carrying {@link GENERATED_COMMAND_MARKER}. A wrapper is not something anybody
 * authored, and its source is the plugin's own command file, which the installed
 * projector already names.
 *
 * @module inventory/commands
 */
import { join } from 'node:path';
import { CLAUDE_COMMANDS_DIR, GENERATED_COMMAND_MARKER } from '../plan/installed-projector.js';
import { listMarkdownFiles, readTextFile } from './read.js';
import type { CommandInventoryEntry, UnreadableSource } from './types.js';

/**
 * Inventory every authored slash command under `.claude/commands`.
 *
 * A file that cannot be read is reported rather than skipped: the engine has to
 * open each one to tell an authored command from a generated wrapper, so a
 * dangling link there is a command whose provenance is genuinely unknown.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the authored commands and any file or directory that could not be read.
 */
export function inventoryCommands(repoRoot: string): {
  commands: CommandInventoryEntry[];
  unreadable: UnreadableSource[];
} {
  const { files, unreadable } = listMarkdownFiles(
    join(repoRoot, CLAUDE_COMMANDS_DIR),
    CLAUDE_COMMANDS_DIR,
    'command',
    { recursive: true }
  );

  const commands: CommandInventoryEntry[] = [];
  for (const file of files) {
    const read = readTextFile(join(repoRoot, file.source), file.source, 'command');
    if (read.text === undefined) {
      if (read.unreadable) unreadable.push(read.unreadable);
      continue;
    }
    if (read.text.includes(GENERATED_COMMAND_MARKER)) continue;
    commands.push({
      kind: 'command',
      name: file.name,
      source: file.source,
      provenance: 'authored',
    });
  }
  return { commands, unreadable };
}
