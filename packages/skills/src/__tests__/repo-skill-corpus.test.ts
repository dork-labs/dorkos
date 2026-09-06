/**
 * Every skill this repo ships must survive its own scanner.
 *
 * `.agents/skills/writing-for-humans/SKILL.md` sat unparseable for two months
 * (DOR-1828): its `description:` held `read: changelog …`, and an unquoted
 * `: ` inside a plain YAML scalar is a nested-mapping error. gray-matter gave
 * the schema an empty object, the scanner logged "name: expected string,
 * received undefined" once per project the skill was projected into, and the
 * skill quietly did not exist for any agent. Nothing red, nothing failing,
 * one warning line in a server log nobody reads.
 *
 * This walks every tracked `SKILL.md` through the same parser + schema the
 * server uses, so the next unquoted colon fails a test instead of a user.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from '../parser.js';
import { SkillFrontmatterSchema } from '../schema.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');

const trackedSkillFiles = execFileSync('git', ['ls-files', '--', '*SKILL.md', '**/SKILL.md'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter((line) => line.length > 0 && !line.includes('/fixtures/'));

describe('every SKILL.md in the repo parses with the production schema', () => {
  it('finds the corpus', () => {
    expect(trackedSkillFiles.length).toBeGreaterThan(10);
  });

  it.each(trackedSkillFiles)('%s', (relativePath) => {
    const absolute = path.join(repoRoot, relativePath);
    const result = parseSkillFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      SkillFrontmatterSchema,
      {
        requireNameMatch: false,
      }
    );
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
  });
});
