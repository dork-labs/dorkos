import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import { SKILL_FILENAME } from './constants.js';

/**
 * Write a SKILL.md file atomically inside a named directory.
 *
 * Creates the directory structure `{parentDir}/{name}/SKILL.md`.
 * Uses temp file + rename to prevent corruption on crash.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - Kebab-case skill name (becomes the directory name)
 * @param frontmatter - YAML frontmatter fields
 * @param body - Markdown body content (agent instructions / prompt)
 * @returns Absolute path to the written SKILL.md file
 */
export async function writeSkillFile(
  parentDir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<string> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });

  const content = matter.stringify(body, frontmatter);
  const targetPath = path.join(skillDir, SKILL_FILENAME);
  const tempPath = path.join(skillDir, `.skill-${randomUUID()}.tmp`);

  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, targetPath);

  return targetPath;
}

/**
 * Delete a skill directory and all its contents.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - Kebab-case skill name (the directory to remove)
 */
export async function deleteSkillDir(parentDir: string, name: string): Promise<void> {
  const skillDir = path.join(parentDir, name);
  await fs.rm(skillDir, { recursive: true, force: true });
}
