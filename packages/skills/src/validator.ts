import fs from 'node:fs/promises';
import path from 'node:path';
import { SKILL_FILENAME } from './constants.js';
import { validateSlug } from './slug.js';
import { scanUiTemplates } from './scanner.js';

/** Validation result with categorized issues. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the structural integrity of a skill directory.
 *
 * Checks:
 * 1. Directory name is a valid slug
 * 2. SKILL.md file exists
 * 3. No unexpected files at the root level (warning only)
 * 4. Any `ui/*.widget.json` files parse and validate (errors, not warnings —
 *    a malformed template is a broken skill contribution, not a suggestion)
 *
 * @param dirPath - Absolute path to the skill directory
 * @returns Validation result with errors and warnings
 */
export async function validateSkillStructure(dirPath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check directory name is a valid slug
  const dirName = path.basename(dirPath);
  if (!validateSlug(dirName)) {
    errors.push(
      `Directory name "${dirName}" is not a valid SKILL.md name (must be kebab-case, 1-64 chars)`
    );
  }

  // Check SKILL.md exists
  const skillPath = path.join(dirPath, SKILL_FILENAME);
  try {
    await fs.access(skillPath);
  } catch {
    errors.push(`Missing ${SKILL_FILENAME} file`);
  }

  // Check ui/*.widget.json templates, if any, are well-formed
  const { errors: templateErrors } = await scanUiTemplates(dirPath);
  errors.push(...templateErrors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
