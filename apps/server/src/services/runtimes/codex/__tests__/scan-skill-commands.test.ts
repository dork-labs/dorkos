import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanSkillCommands } from '../scan-skill-commands.js';

/**
 * Write a valid `<cwd>/.agents/skills/<name>/SKILL.md`. Extra frontmatter
 * lines (e.g. `user-invocable: false`) are appended verbatim.
 */
async function writeSkill(
  root: string,
  name: string,
  description: string,
  extraFrontmatter = ''
): Promise<void> {
  const dir = path.join(root, '.agents', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n# ${name}\n`,
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

  it('leaves a user-invocable:false skill out of the palette', async () => {
    await writeSkill(cwd, 'deploy', 'Ship the app to production');
    await writeSkill(cwd, 'house-style', 'Background knowledge', 'user-invocable: false\n');

    expect(scanSkillCommands(cwd)).toEqual([
      { command: 'deploy', fullCommand: '/deploy', description: 'Ship the app to production' },
    ]);
  });

  it('keeps a disable-model-invocation:true skill — person-only is what a palette is for', async () => {
    await writeSkill(cwd, 'release', 'Cut a release', 'disable-model-invocation: true\n');

    expect(scanSkillCommands(cwd)).toEqual([
      { command: 'release', fullCommand: '/release', description: 'Cut a release' },
    ]);
  });

  it('keeps a skill that declares user-invocable:true explicitly', async () => {
    await writeSkill(cwd, 'deploy', 'Ship the app', 'user-invocable: true\n');

    expect(scanSkillCommands(cwd).map((c) => c.command)).toEqual(['deploy']);
  });
});
