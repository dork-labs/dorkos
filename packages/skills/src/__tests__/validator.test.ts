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

  it('valid structure with a well-formed ui/ template passes', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, SKILL_FILENAME), '---\nname: my-skill\n---\nBody');
    const uiDir = path.join(skillDir, 'ui');
    await fs.mkdir(uiDir);
    await fs.writeFile(
      path.join(uiDir, 'weather-card.widget.json'),
      JSON.stringify({
        name: 'weather-card',
        description: 'A stat card for current conditions.',
        document: { version: 1, root: { type: 'stat', label: 'Temp', value: '{{temperature}}' } },
      })
    );

    const result = await validateSkillStructure(skillDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('malformed JSON in ui/ is reported as a skill validation error, not a crash', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, SKILL_FILENAME), '---\nname: my-skill\n---\nBody');
    const uiDir = path.join(skillDir, 'ui');
    await fs.mkdir(uiDir);
    await fs.writeFile(path.join(uiDir, 'broken.widget.json'), '{ not valid json');

    const result = await validateSkillStructure(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ui/broken.widget.json'))).toBe(true);
  });

  it('a schema-invalid template in ui/ is reported as a skill validation error', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, SKILL_FILENAME), '---\nname: my-skill\n---\nBody');
    const uiDir = path.join(skillDir, 'ui');
    await fs.mkdir(uiDir);
    await fs.writeFile(
      path.join(uiDir, 'bad.widget.json'),
      JSON.stringify({ name: 'bad', description: 'Missing document field entirely.' })
    );

    const result = await validateSkillStructure(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ui/bad.widget.json'))).toBe(true);
  });
});
