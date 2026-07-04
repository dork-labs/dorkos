import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanSkillCommands } from '../scan-skill-commands.js';

/** Write a valid `<cwd>/.agents/skills/<name>/SKILL.md`. */
async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const dir = path.join(root, '.agents', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf-8'
  );
}

describe('scanSkillCommands', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'codex-skills-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('maps each project skill to a /<name> command with its frontmatter description', async () => {
    await writeSkill(cwd, 'deploy', 'Ship the app to production');
    await writeSkill(cwd, 'analyze', 'Analyze the codebase');

    const commands = scanSkillCommands(cwd);

    // Sorted by fullCommand for a deterministic palette.
    expect(commands).toEqual([
      { command: 'analyze', fullCommand: '/analyze', description: 'Analyze the codebase' },
      { command: 'deploy', fullCommand: '/deploy', description: 'Ship the app to production' },
    ]);
  });

  it('returns an empty list when .agents/skills is absent', () => {
    expect(scanSkillCommands(cwd)).toEqual([]);
  });

  it('skips a skill whose SKILL.md has invalid frontmatter, keeping the rest', async () => {
    await writeSkill(cwd, 'good', 'A valid skill');
    // Missing required `description` → parse fails, skill is skipped (not fatal).
    const badDir = path.join(cwd, '.agents', 'skills', 'bad');
    await mkdir(badDir, { recursive: true });
    await writeFile(
      path.join(badDir, 'SKILL.md'),
      `---\nname: bad\n---\n\nno description\n`,
      'utf-8'
    );

    expect(scanSkillCommands(cwd)).toEqual([
      { command: 'good', fullCommand: '/good', description: 'A valid skill' },
    ]);
  });
});
