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

    let raw: string;
    try {
      raw = await fsPromises.readFile(path.join(uiDir, entry.name), 'utf-8');
    } catch (err) {
      errors.push(`Failed to read widget template "${relPath}": ${(err as Error).message}`);
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      errors.push(`Widget template "${relPath}" is not valid JSON: ${(err as Error).message}`);
      continue;
    }

    const result = WidgetTemplateSchema.safeParse(json);
    if (!result.success) {
      errors.push(`Invalid widget template "${relPath}": ${result.error.message}`);
      continue;
    }
    templates.push(result.data);
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
 * Two failure shapes are deliberately distinguished, because callers act on
 * the difference:
 *
 * - **Absent** — `dir` itself does not exist, so the scan is empty; or a
 *   subdirectory has no SKILL.md, so its failure carries `fileMissing: true`.
 *   These mean "nothing is there".
 * - **Unreachable** — the read failed for any other reason (EACCES, EMFILE,
 *   EIO). An unreadable `dir` THROWS; an unreadable SKILL.md is a failure
 *   without `fileMissing`. These mean "could not look", which is never
 *   evidence of absence.
 *
 * @param dir - Parent directory to scan (e.g., `.dork/tasks/`)
 * @param schema - Zod schema to validate frontmatter
 * @param options - Optional settings
 * @param options.includeMissing - If true (default), include `ok: false` entries
 *   for subdirectories that lack a SKILL.md. Set to false for the old
 *   behavior of silently skipping them. Suppresses absent skills only —
 *   an unreadable SKILL.md is still reported.
 * @param options.withUiTemplates - If true, also scan each skill's `ui/`
 *   subdirectory and populate `uiTemplates` on the parsed result. Off by
 *   default so callers that never read templates (e.g. the task reconciler)
 *   pay no extra I/O; when off, `uiTemplates` is `undefined`.
 * @param options.logger - Receives a debug entry when a skill's malformed
 *   `ui/*.widget.json` templates are dropped from `uiTemplates` (only
 *   relevant with `withUiTemplates`). A dropped template does not fail the
 *   skill here — `validateSkillStructure` is the surface that reports it as
 *   an error. Defaults to a no-op.
 * @param options.requireNameMatch - Forwarded to {@link parseSkillFile}: when
 *   `false`, a frontmatter `name` that differs from the directory name does
 *   not fail the parse (Claude Code compatibility, DOR-263). Defaults to `true`.
 * @param options.ignoreDirs - Subdirectory names that are containers rather
 *   than skills, and so are skipped entirely — never parsed, never reported
 *   as missing a SKILL.md. Use it for a directory the caller itself owns
 *   (e.g. the task-templates container inside a tasks directory); without it
 *   such a container reads as a skill that forgot its SKILL.md. Defaults to
 *   none, so every subdirectory is treated as a skill.
 * @returns Array of parse results (both successes and failures)
 * @throws If `dir` exists but cannot be listed. A caller that reads absence as
 *   deletion must let this propagate rather than degrade it to an empty scan.
 */
export async function scanSkillDirectory<T>(
  dir: string,
  schema: z.ZodType<T, unknown>,
  options?: {
    includeMissing?: boolean;
    withUiTemplates?: boolean;
    logger?: Logger;
    requireNameMatch?: boolean;
    ignoreDirs?: readonly string[];
  }
): Promise<ParseResult<ParsedSkill<T>>[]> {
  const includeMissing = options?.includeMissing ?? true;
  const withUiTemplates = options?.withUiTemplates ?? false;
  const logger = options?.logger ?? noopLogger;
  const ignoreDirs = new Set(options?.ignoreDirs ?? []);
  const results: ParseResult<ParsedSkill<T>>[] = [];

  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that isn't there is genuinely empty. Anything else — EACCES,
    // EMFILE under fd pressure, EIO — means we could not LOOK, which is not the
    // same answer as looking and finding nothing. Returning `[]` for those
    // would tell a caller that every skill it expected has been deleted, so
    // they are thrown and the caller decides.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return results;
    throw err;
  }

  for (const entry of entries) {
    // Skip non-directories, dotfiles, and caller-declared containers
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (ignoreDirs.has(entry.name)) continue;

    const skillPath = path.join(dir, entry.name, SKILL_FILENAME);

    let content: string;
    try {
      content = await fsPromises.readFile(skillPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // No SKILL.md in this directory — the one failure that means "gone".
        if (includeMissing) {
          results.push({
            ok: false,
            error: `No ${SKILL_FILENAME} found in directory "${entry.name}"`,
            filePath: skillPath,
            fileMissing: true,
          });
        }
        continue;
      }
      // The file is there, we just could not read it. Report it as a failure
      // WITHOUT `fileMissing`, so nobody mistakes it for a deletion. Reported
      // even under `includeMissing: false`, which suppresses absent skills —
      // an unreadable one is a real problem, not an absent one.
      results.push({
        ok: false,
        error: `Failed to read ${SKILL_FILENAME} in directory "${entry.name}": ${(err as Error).message}`,
        filePath: skillPath,
      });
      continue;
    }

    const parsed = parseSkillFile(skillPath, content, schema, {
      requireNameMatch: options?.requireNameMatch,
    });
    if (!parsed.ok || !withUiTemplates) {
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
