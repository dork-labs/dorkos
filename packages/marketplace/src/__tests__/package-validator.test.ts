import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validatePackage } from '../package-validator.js';
import { CLAUDE_PLUGIN_MANIFEST_PATH, PACKAGE_MANIFEST_PATH } from '../constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * Create an isolated temporary directory for a single test.
 */
async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `marketplace-validator-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write a JSON file at the given path, creating parent directories as needed.
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

/**
 * Write an arbitrary text file, creating parent directories as needed.
 */
async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

describe('validatePackage', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      const p = tempPaths.pop();
      if (p) {
        await fs.rm(p, { recursive: true, force: true });
      }
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await makeTempDir();
    tempPaths.push(dir);
    return dir;
  }

  describe('MANIFEST_MISSING', () => {
    it('reports MANIFEST_MISSING for invalid-no-manifest fixture', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'invalid-no-manifest'));

      expect(result.ok).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        level: 'error',
        code: 'MANIFEST_MISSING',
        path: PACKAGE_MANIFEST_PATH,
      });
    });

    it('reports MANIFEST_MISSING for a pure Claude Code plugin (no .dork/)', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'claude-code-plugin'));

      expect(result.ok).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.issues.some((i) => i.code === 'MANIFEST_MISSING')).toBe(true);
    });
  });

  describe('MANIFEST_INVALID_JSON', () => {
    it('reports MANIFEST_INVALID_JSON when manifest is not valid JSON', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'broken-pkg');
      await writeText(path.join(pkg, PACKAGE_MANIFEST_PATH), '{ this is not json');

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        level: 'error',
        code: 'MANIFEST_INVALID_JSON',
        path: PACKAGE_MANIFEST_PATH,
      });
    });
  });

  describe('MANIFEST_SCHEMA_INVALID', () => {
    it('reports MANIFEST_SCHEMA_INVALID for invalid-manifest-shape fixture', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'invalid-manifest-shape'));

      expect(result.ok).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((i) => i.code === 'MANIFEST_SCHEMA_INVALID')).toBe(true);
      expect(result.issues.every((i) => i.level === 'error')).toBe(true);
    });
  });

  describe('CLAUDE_PLUGIN_MISSING', () => {
    it('reports CLAUDE_PLUGIN_MISSING for a plugin package without .claude-plugin/plugin.json', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'no-cc-plugin');
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'no-cc-plugin',
        version: '1.0.0',
        type: 'plugin',
        description: 'A plugin missing its claude-plugin manifest',
        license: 'MIT',
        tags: [],
        layers: [],
        extensions: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'CLAUDE_PLUGIN_MISSING')).toBe(true);
      const ccIssue = result.issues.find((i) => i.code === 'CLAUDE_PLUGIN_MISSING');
      expect(ccIssue).toMatchObject({
        level: 'error',
        path: CLAUDE_PLUGIN_MANIFEST_PATH,
      });
    });

    it('does NOT report CLAUDE_PLUGIN_MISSING for valid-agent fixture', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'valid-agent'));

      expect(result.issues.some((i) => i.code === 'CLAUDE_PLUGIN_MISSING')).toBe(false);
      expect(result.ok).toBe(true);
    });
  });

  describe('SKILL_INVALID', () => {
    it('reports SKILL_INVALID when a bundled SKILL.md has a name/dir mismatch', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'bad-skill-pkg');

      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'bad-skill-pkg',
        version: '1.0.0',
        type: 'plugin',
        description: 'A plugin with a malformed SKILL.md',
        license: 'MIT',
        tags: [],
        layers: ['skills'],
        extensions: [],
      });
      await writeJson(path.join(pkg, CLAUDE_PLUGIN_MANIFEST_PATH), {
        name: 'bad-skill-pkg',
        version: '1.0.0',
        description: 'plugin manifest',
      });

      // Skill directory called "right-name" but frontmatter declares
      // a different name — parser rejects this with an error.
      await writeText(
        path.join(pkg, 'skills', 'right-name', 'SKILL.md'),
        '---\nname: wrong-name\ndescription: malformed\n---\nBody\n'
      );

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'SKILL_INVALID')).toBe(true);
    });
  });

  describe('NAME_DIRECTORY_MISMATCH', () => {
    it('emits a warning (not error) when directory name and manifest name differ', async () => {
      const dir = await tempDir();
      // Directory is "renamed-dir" but manifest.name is "actual-name"
      const pkg = path.join(dir, 'renamed-dir');

      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'actual-name',
        version: '1.0.0',
        type: 'agent',
        description: 'Mismatched directory name',
        license: 'MIT',
        tags: [],
        layers: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(true);
      const mismatch = result.issues.find((i) => i.code === 'NAME_DIRECTORY_MISMATCH');
      expect(mismatch).toBeDefined();
      expect(mismatch?.level).toBe('warning');
      expect(mismatch?.message).toContain('renamed-dir');
      expect(mismatch?.message).toContain('actual-name');
    });
  });

  describe('valid fixtures', () => {
    const validFixtures = [
      'valid-plugin',
      'valid-agent',
      'valid-skill-pack',
      'valid-adapter',
    ] as const;

    it.each(validFixtures)('passes validation: %s', async (name) => {
      const result = await validatePackage(path.join(FIXTURES_DIR, name));

      expect(result.ok).toBe(true);
      expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
      expect(result.manifest).toBeDefined();
      expect(result.manifest?.name).toBe(name);
    });
  });
});
