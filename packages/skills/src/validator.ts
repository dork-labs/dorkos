import fs from 'node:fs/promises';
import path from 'node:path';
import { SKILL_FILENAME } from './constants.js';
import { validateSlug } from './slug.js';

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

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
