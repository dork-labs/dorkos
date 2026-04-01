import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSkillFile, deleteSkillDir } from '../writer.js';
import { SKILL_FILENAME } from '../constants.js';

describe('writeSkillFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-writer-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates directory structure', async () => {
    await writeSkillFile(tmpDir, 'my-task', { name: 'my-task', description: 'Test' }, 'Body');

    const dirExists = await fs
      .stat(path.join(tmpDir, 'my-task'))
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(true);
  });

  it('writes valid SKILL.md content', async () => {
    const filePath = await writeSkillFile(
      tmpDir,
      'my-task',
      { name: 'my-task', description: 'A test task' },
      'Do the thing.'
    );

    expect(filePath).toBe(path.join(tmpDir, 'my-task', SKILL_FILENAME));

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('name: my-task');
    expect(content).toContain('description: A test task');
    expect(content).toContain('Do the thing.');
  });

  it('overwrites existing file', async () => {
    await writeSkillFile(tmpDir, 'my-task', { name: 'my-task', description: 'v1' }, 'First');
    await writeSkillFile(tmpDir, 'my-task', { name: 'my-task', description: 'v2' }, 'Second');

    const content = await fs.readFile(path.join(tmpDir, 'my-task', SKILL_FILENAME), 'utf-8');
    expect(content).toContain('description: v2');
    expect(content).toContain('Second');
  });

  it('atomic write leaves no temp files', async () => {
    await writeSkillFile(tmpDir, 'my-task', { name: 'my-task', description: 'Test' }, 'Body');

    const files = await fs.readdir(path.join(tmpDir, 'my-task'));
    expect(files).toEqual([SKILL_FILENAME]);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('deleteSkillDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-writer-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('removes directory and contents', async () => {
    await writeSkillFile(tmpDir, 'my-task', { name: 'my-task', description: 'Test' }, 'Body');
    await deleteSkillDir(tmpDir, 'my-task');

    const exists = await fs
      .stat(path.join(tmpDir, 'my-task'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('does not throw for non-existent directory', async () => {
    await expect(deleteSkillDir(tmpDir, 'nonexistent')).resolves.not.toThrow();
  });
});
