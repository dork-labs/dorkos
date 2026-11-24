/**
 * Claude Code's own temp folder for a project (DOR-5236): `<temp>/claude-<uid>/<project>/`, where
 * the CLI keeps each session's background task output (`tasks/`) and scratch files
 * (`scratchpad/`). `<temp>` is `CLAUDE_CODE_TMPDIR` when set, else the system temp folder, and
 * `<project>` is the working folder with every character but a letter or digit turned into `-`.
 *
 * Reading a file there does not mark a turn: it is the agent's own output, and the call that made
 * it was judged when it ran.
 *
 * @module services/runtimes/shared/tools/claude-code-scratch
 */
import os from 'node:os';
import path from 'node:path';

/** How the CLI names a project's folder: the working folder, with non-alphanumerics as `-`. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The folders Claude Code keeps a project's sessions' own files in, in each spelling given.
 *
 * @param cwdSpellings - The working folder, as written and as the filesystem resolves it.
 * @param spell - Expands one folder into its spellings (as written and resolved).
 * @returns The project folders; none where the user id is unknown (Windows).
 */
export function claudeCodeScratchFolders(
  cwdSpellings: readonly string[],
  spell: (folder: string) => string[]
): string[] {
  const uid = process.getuid?.();
  if (uid === undefined || cwdSpellings.length === 0) return [];
  // eslint-disable-next-line no-restricted-syntax -- CLAUDE_CODE_TMPDIR is the Claude Code CLI's own variable, mirrored here, not a DorkOS setting env.ts models
  const configured = process.env.CLAUDE_CODE_TMPDIR;
  const bases = [...(configured ? [configured] : []), '/tmp', os.tmpdir()].flatMap(spell);
  const slugs = [...new Set(cwdSpellings.map(projectSlug))];
  return [...new Set(bases)].flatMap((base) =>
    slugs.map((slug) => path.join(base, `claude-${uid}`, slug))
  );
}
