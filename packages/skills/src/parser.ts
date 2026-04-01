import matter from 'gray-matter';
import path from 'node:path';
import type { z } from 'zod';
import { SKILL_FILENAME } from './constants.js';
import type { ParseResult } from './types.js';

/** The parsed output from a SKILL.md file. */
export interface ParsedSkill<T> {
  /** Kebab-case name (from directory name). */
  name: string;
  /** Validated frontmatter. */
  meta: T;
  /** Markdown body content. */
  body: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Absolute path to the skill directory. */
  dirPath: string;
}

/**
 * Parse a SKILL.md file and validate its frontmatter against a Zod schema.
 *
 * Validates that:
 * 1. The file is named SKILL.md
 * 2. Frontmatter passes the provided schema
 * 3. The `name` field in frontmatter matches the parent directory name
 *
 * @param filePath - Absolute path to the SKILL.md file
 * @param content - Raw file content (UTF-8)
 * @param schema - Zod schema to validate frontmatter against
 * @returns ParseResult with the validated definition or an error
 */
export function parseSkillFile<T>(
  filePath: string,
  content: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): ParseResult<ParsedSkill<T>> {
  // Validate filename
  const filename = path.basename(filePath);
  if (filename !== SKILL_FILENAME) {
    return {
      ok: false,
      error: `Expected filename "${SKILL_FILENAME}", got "${filename}"`,
      filePath,
    };
  }

  // Parse frontmatter
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content);
    data = parsed.data;
    body = parsed.content.trim();
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse frontmatter: ${(err as Error).message}`,
      filePath,
    };
  }

  // Validate with schema
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid frontmatter: ${result.error.message}`,
      filePath,
    };
  }

  // Derive name from parent directory
  const dirPath = path.dirname(filePath);
  const dirName = path.basename(dirPath);

  // Validate name matches directory (when schema includes a name field)
  const meta = result.data as Record<string, unknown>;
  if (typeof meta.name === 'string' && meta.name !== dirName) {
    return {
      ok: false,
      error: `Frontmatter name "${meta.name}" does not match directory name "${dirName}"`,
      filePath,
    };
  }

  return {
    ok: true,
    definition: {
      name: dirName,
      meta: result.data,
      body,
      filePath,
      dirPath,
    },
  };
}
