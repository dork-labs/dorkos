import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSkillStructure } from '../validator.js';
import { SKILL_FILENAME } from '../constants.js';

describe('validateSkillStructure', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-validator-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('valid structure passes', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, SKILL_FILENAME), '---\nname: my-skill\n---\nBody');

    const result = await validateSkillStructure(skillDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('missing SKILL.md fails', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fs.mkdir(skillDir);

    const result = await validateSkillStructure(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`Missing ${SKILL_FILENAME} file`);
  });

  it('invalid directory name fails', async () => {
    const skillDir = path.join(tmpDir, 'INVALID_NAME');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, SKILL_FILENAME), '---\nname: test\n---\nBody');

    const result = await validateSkillStructure(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('not a valid SKILL.md name');
  });

  it('reports multiple errors', async () => {
    const skillDir = path.join(tmpDir, 'INVALID');
    await fs.mkdir(skillDir);
    // No SKILL.md and invalid name

    const result = await validateSkillStructure(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
