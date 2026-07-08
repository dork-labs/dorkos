import { type Dirent } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { noopLogger, type Logger } from '@dorkos/shared/logger';
import { SKILL_FILENAME, WIDGET_TEMPLATE_SUFFIX } from './constants.js';
import { parseSkillFile, type ParsedSkill } from './parser.js';
import { WidgetTemplateSchema, type WidgetTemplate } from './ui-template.js';
import type { ParseResult } from './types.js';

/** Name of the widget-template subdirectory inside a skill directory. */
const UI_TEMPLATES_DIRNAME = 'ui';

/** Result of scanning a skill directory's `ui/*.widget.json` templates. */
export interface UiTemplateScanResult {
  /** Templates that parsed and passed {@link WidgetTemplateSchema}. */
  templates: WidgetTemplate[];
  /** One message per file that failed to read, parse as JSON, or validate. */
  errors: string[];
}

/**
 * Scan a skill directory's `ui/` subdirectory for widget templates.
 *
 * A missing `ui/` directory is not an error — most skills don't ship
 * templates. Only files ending in `.widget.json` are considered; anything
 * else under `ui/` is ignored. Read, parse, and validation failures are
 * collected as messages rather than thrown, so one bad template file never
 * aborts the scan or crashes the caller.
 *
 * @param skillDirPath - Absolute path to the skill directory (parent of SKILL.md)
 * @returns Valid templates and one error message per malformed file
 */
export async function scanUiTemplates(skillDirPath: string): Promise<UiTemplateScanResult> {
  const templates: WidgetTemplate[] = [];
  const errors: string[] = [];
  const uiDir = path.join(skillDirPath, UI_TEMPLATES_DIRNAME);

  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(uiDir, { withFileTypes: true });
  } catch {
    // No ui/ directory — not an error.
    return { templates, errors };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(WIDGET_TEMPLATE_SUFFIX)) continue;
    const relPath = `${UI_TEMPLATES_DIRNAME}/${entry.name}`;

    try {
      const raw = await fsPromises.readFile(path.join(uiDir, entry.name), 'utf-8');
      const result = WidgetTemplateSchema.safeParse(JSON.parse(raw));
      if (!result.success) {
        errors.push(`Invalid widget template "${relPath}": ${result.error.message}`);
        continue;
      }
      templates.push(result.data);
    } catch (err) {
      errors.push(`Failed to read widget template "${relPath}": ${(err as Error).message}`);
    }
  }

  return { templates, errors };
}

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
 * @param options.logger - Receives a debug entry when a skill's malformed
 *   `ui/*.widget.json` templates are dropped from `uiTemplates`. A dropped
 *   template does not fail the skill here — `validateSkillStructure` is the
 *   surface that reports it as an error. Defaults to a no-op.
 * @returns Array of parse results (both successes and failures)
 */
export async function scanSkillDirectory<T>(
  dir: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options?: { includeMissing?: boolean; logger?: Logger }
): Promise<ParseResult<ParsedSkill<T>>[]> {
  const includeMissing = options?.includeMissing ?? true;
  const logger = options?.logger ?? noopLogger;
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

    const parsed = parseSkillFile(skillPath, content, schema);
    if (!parsed.ok) {
      results.push(parsed);
      continue;
    }

    const { templates, errors: templateErrors } = await scanUiTemplates(path.join(dir, entry.name));
    if (templateErrors.length > 0) {
      logger.debug(
        `Skill "${entry.name}": dropped ${templateErrors.length} malformed widget template(s)`,
        templateErrors
      );
    }
    results.push({ ok: true, definition: { ...parsed.definition, uiTemplates: templates } });
  }

  return results;
}
