import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanSkillDirectory } from '../scanner.js';
import { SkillFrontmatterSchema } from '../schema.js';
import { SKILL_FILENAME } from '../constants.js';

describe('scanSkillDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-scanner-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createSkill(name: string, content: string): Promise<void> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, SKILL_FILENAME), content, 'utf-8');
  }

  it('scans directory with multiple valid skills', async () => {
    await createSkill('skill-a', '---\nname: skill-a\ndescription: First\n---\nBody A');
    await createSkill('skill-b', '---\nname: skill-b\ndescription: Second\n---\nBody B');

    const results = await scanSkillDirectory(tmpDir, SkillFrontmatterSchema);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('skips dotfile directories', async () => {
    await createSkill('.hidden', '---\nname: hidden\ndescription: Hidden\n---\nBody');
    await createSkill('visible', '---\nname: visible\ndescription: Visible\n---\nBody');

    const results = await scanSkillDirectory(tmpDir, SkillFrontmatterSchema);
    expect(results).toHaveLength(1);
    if (results[0].ok) {
      expect(results[0].definition.name).toBe('visible');
    }
  });

  it('surfaces directories without SKILL.md as failures by default', async () => {
    const emptyDir = path.join(tmpDir, 'empty-dir');
    await fs.mkdir(emptyDir);
    await createSkill('valid', '---\nname: valid\ndescription: Valid\n---\nBody');

    const results = await scanSkillDirectory(tmpDir, SkillFrontmatterSchema);
    expect(results).toHaveLength(2);

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].ok).toBe(false);
    if (!failures[0].ok) {
      expect(failures[0].error).toContain('No SKILL.md found');
      expect(failures[0].error).toContain('empty-dir');
    }
  });

  it('silently skips missing SKILL.md when includeMissing is false', async () => {
    const emptyDir = path.join(tmpDir, 'empty-dir');
    await fs.mkdir(emptyDir);
    await createSkill('valid', '---\nname: valid\ndescription: Valid\n---\nBody');

    const results = await scanSkillDirectory(tmpDir, SkillFrontmatterSchema, {
      includeMissing: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it('returns empty array for non-existent directory', async () => {
    const results = await scanSkillDirectory('/nonexistent/path', SkillFrontmatterSchema);
    expect(results).toEqual([]);
  });

  it('includes both successes and failures in results', async () => {
    await createSkill('valid', '---\nname: valid\ndescription: Valid\n---\nBody');
    await createSkill('invalid', '---\nname: INVALID\ndescription: Bad name\n---\nBody');

    const results = await scanSkillDirectory(tmpDir, SkillFrontmatterSchema);
    expect(results).toHaveLength(2);

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('handles mixed valid/invalid entries gracefully', async () => {
    await createSkill('good', '---\nname: good\ndescription: Good\n---\nBody');
    // Directory with no SKILL.md — surfaced as a failure
    await fs.mkdir(path.join(tmpDir, 'no-skill'));
    // File (not directory) at root level — ignored entirely (not a directory)
    await fs.writeFile(path.join(tmpDir, 'stray-file.txt'), 'not a skill');
    await createSkill('also-good', '---\nname: also-good\ndescription: Also Good\n---\nBody');

    const results = await scanSkillDirectory(tmpDir, SkillFrontmatterSchema);
    // 2 valid skills + 1 missing-SKILL.md failure
    expect(results).toHaveLength(3);

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(2);
    expect(failures).toHaveLength(1);
    if (!failures[0].ok) {
      expect(failures[0].error).toContain('no-skill');
    }
  });
});
