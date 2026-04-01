import { type Dirent } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { SKILL_FILENAME } from './constants.js';
import { parseSkillFile, type ParsedSkill } from './parser.js';
import type { ParseResult } from './types.js';

/**
 * Scan a directory for skill subdirectories and parse each SKILL.md.
 *
 * Looks for subdirectories containing a SKILL.md file. Ignores
 * non-directory entries and dotfiles. Directories without a SKILL.md
 * are included in the results as `{ ok: false }` entries so callers
 * have full visibility into what was skipped and why.
 *
 * @param dir - Parent directory to scan (e.g., `.dork/tasks/`)
 * @param schema - Zod schema to validate frontmatter
 * @param options - Optional settings
 * @param options.includeMissing - If true (default), include `ok: false` entries
 *   for subdirectories that lack a SKILL.md. Set to false for the old
 *   behavior of silently skipping them.
 * @returns Array of parse results (both successes and failures)
 */
export async function scanSkillDirectory<T>(
  dir: string,
  schema: z.ZodSchema<T>,
  options?: { includeMissing?: boolean }
): Promise<ParseResult<ParsedSkill<T>>[]> {
  const includeMissing = options?.includeMissing ?? true;
  const results: ParseResult<ParsedSkill<T>>[] = [];

  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist — return empty, not an error
    return results;
  }

  for (const entry of entries) {
    // Skip non-directories and dotfiles
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const skillPath = path.join(dir, entry.name, SKILL_FILENAME);

    let content: string;
    try {
      content = await fsPromises.readFile(skillPath, 'utf-8');
    } catch {
      // No SKILL.md in this directory
      if (includeMissing) {
        results.push({
          ok: false,
          error: `No ${SKILL_FILENAME} found in directory "${entry.name}"`,
          filePath: skillPath,
        });
      }
      continue;
    }

    results.push(parseSkillFile(skillPath, content, schema));
  }

  return results;
}
