import matter from 'gray-matter';
import path from 'node:path';
import type { z } from 'zod';
import { SKILL_FILENAME } from './constants.js';
import type { ParseResult } from './types.js';
import type { WidgetTemplate } from './ui-template.js';

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
  /**
   * Widget templates discovered under `ui/*.widget.json`. Only populated by
   * `scanSkillDirectory` when its `withUiTemplates` option is set —
   * `parseSkillFile` parses SKILL.md content alone, and scans without the
   * flag skip the `ui/` I/O entirely — so this is `undefined` otherwise.
   *
   * Agents do not consume this — they read the template files directly per
   * the `<gen_ui>` teaching block. This is the programmatic discovery
   * surface for install-time tooling: marketplace skill-pack validation
   * (`services/marketplace/flows/install-skill-pack.ts`) and the
   * template-registration follow-ups planned in `specs/gen-ui-tier1`.
   */
  uiTemplates?: WidgetTemplate[];
}

/** Options for {@link parseSkillFile}. */
export interface ParseSkillFileOptions {
  /**
   * Whether a frontmatter `name` that differs from the parent directory name
   * fails the parse. Defaults to `true` — the right strictness for content
   * DorkOS authors itself (tasks, personal skills), where the two are kept in
   * lockstep by the writer.
   *
   * Pass `false` when consuming third-party Claude Code content: CC keys a
   * skill by its DIRECTORY name and tolerates a divergent frontmatter name
   * (Anthropic's own `hookify` plugin ships one), so a superset consumer must
   * accept it too (DOR-263). The parsed definition's `name` is always the
   * directory name either way.
   */
  requireNameMatch?: boolean;
}

/**
 * Read a SKILL.md's frontmatter EXACTLY as the author wrote it, with no schema
 * anywhere near it.
 *
 * The base for any rewrite has to be this, never a parsed `meta`. Parsing is
 * lossy in both directions: it fills defaults in (so a rewrite materializes
 * `timezone`/`enabled`/`permissions` the author never typed), it strips keys the
 * schema does not know, and — the reason this exists — it can replace a value
 * with a DIFFERENT SHAPE. A `schedule:` block that does not validate parses to a
 * complaint object, and writing that back would replace the author's cron with
 * `{invalid, problem}` and lose their schedule for good (DOR-1485 review, B1).
 *
 * @param content - Raw file content (UTF-8).
 * @returns The frontmatter mapping and the trimmed body, or `null` when the
 *   content's frontmatter is malformed enough that gray-matter refuses it.
 */
export function readRawFrontmatter(
  content: string
): { data: Record<string, unknown>; body: string } | null {
  try {
    const parsed = matter(content);
    return { data: parsed.data, body: parsed.content.trim() };
  } catch {
    return null;
  }
}

/**
 * Parse a SKILL.md file and validate its frontmatter against a Zod schema.
 *
 * Validates that:
 * 1. The file is named SKILL.md
 * 2. Frontmatter passes the provided schema
 * 3. The `name` field in frontmatter matches the parent directory name
 *    (unless `options.requireNameMatch` is `false`)
 *
 * @param filePath - Absolute path to the SKILL.md file
 * @param content - Raw file content (UTF-8)
 * @param schema - Zod schema to validate frontmatter against
 * @param options - Parse strictness options
 * @returns ParseResult with the validated definition or an error
 */
export function parseSkillFile<T>(
  filePath: string,
  content: string,
  schema: z.ZodType<T, unknown>,
  options?: ParseSkillFileOptions
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
  const requireNameMatch = options?.requireNameMatch ?? true;
  const meta = result.data as Record<string, unknown>;
  if (requireNameMatch && typeof meta.name === 'string' && meta.name !== dirName) {
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
