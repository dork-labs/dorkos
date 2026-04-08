import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createPackage } from '../scaffolder.js';
import { validatePackage } from '../package-validator.js';
import { CLAUDE_PLUGIN_MANIFEST_PATH, PACKAGE_MANIFEST_PATH } from '../constants.js';
import type { PackageType } from '../package-types.js';

/**
 * Create an isolated temporary directory for a single test.
 */
async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `marketplace-scaffolder-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Read and JSON-parse a file at the given absolute path.
 */
async function readJson(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Assert that a path exists on disk. Returns the entry's `Stats` so callers
 * can perform additional assertions (e.g. `isDirectory()`).
 */
async function assertExists(p: string): Promise<void> {
  await expect(fs.access(p)).resolves.toBeUndefined();
}

/**
 * Assert that a path does NOT exist on disk.
 */
async function assertMissing(p: string): Promise<void> {
  await expect(fs.access(p)).rejects.toThrow();
}

describe('createPackage', () => {
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

  describe('plugin packages', () => {
    it('creates a plugin package with all expected files and starter directories', async () => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: 'test-plugin',
        type: 'plugin',
      });

      expect(result.packagePath).toBe(path.join(parentDir, 'test-plugin'));
      expect(result.filesWritten).toContain(PACKAGE_MANIFEST_PATH);
      expect(result.filesWritten).toContain(CLAUDE_PLUGIN_MANIFEST_PATH);
      expect(result.filesWritten).toContain('README.md');

      await assertExists(path.join(result.packagePath, PACKAGE_MANIFEST_PATH));
      await assertExists(path.join(result.packagePath, CLAUDE_PLUGIN_MANIFEST_PATH));
      await assertExists(path.join(result.packagePath, 'README.md'));

      // Starter directories
      await assertExists(path.join(result.packagePath, 'skills'));
      await assertExists(path.join(result.packagePath, 'hooks'));
      await assertExists(path.join(result.packagePath, 'commands'));
    });
  });

  describe('agent packages', () => {
    it('creates an agent package without a .claude-plugin directory', async () => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: 'test-agent',
        type: 'agent',
      });

      expect(result.filesWritten).toContain(PACKAGE_MANIFEST_PATH);
      expect(result.filesWritten).toContain('README.md');
      expect(result.filesWritten).not.toContain(CLAUDE_PLUGIN_MANIFEST_PATH);

      await assertExists(path.join(result.packagePath, PACKAGE_MANIFEST_PATH));
      await assertExists(path.join(result.packagePath, 'README.md'));
      await assertExists(path.join(result.packagePath, '.claude/skills'));
      await assertExists(path.join(result.packagePath, '.dork/tasks'));

      // Agent packages must NOT include a Claude Code plugin manifest.
      await assertMissing(path.join(result.packagePath, '.claude-plugin'));
    });
  });

  describe('skill-pack packages', () => {
    it('creates a skill-pack package with skills/ starter directory', async () => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: 'test-skill-pack',
        type: 'skill-pack',
      });

      expect(result.filesWritten).toContain(PACKAGE_MANIFEST_PATH);
      expect(result.filesWritten).toContain(CLAUDE_PLUGIN_MANIFEST_PATH);
      expect(result.filesWritten).toContain('README.md');

      await assertExists(path.join(result.packagePath, PACKAGE_MANIFEST_PATH));
      await assertExists(path.join(result.packagePath, CLAUDE_PLUGIN_MANIFEST_PATH));
      await assertExists(path.join(result.packagePath, 'README.md'));
      await assertExists(path.join(result.packagePath, 'skills'));
    });
  });

  describe('adapter packages', () => {
    it('creates an adapter package with .dork/adapters/ starter directory', async () => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: 'test-adapter',
        type: 'adapter',
      });

      expect(result.filesWritten).toContain(PACKAGE_MANIFEST_PATH);
      expect(result.filesWritten).toContain(CLAUDE_PLUGIN_MANIFEST_PATH);
      expect(result.filesWritten).toContain('README.md');

      await assertExists(path.join(result.packagePath, PACKAGE_MANIFEST_PATH));
      await assertExists(path.join(result.packagePath, CLAUDE_PLUGIN_MANIFEST_PATH));
      await assertExists(path.join(result.packagePath, 'README.md'));
      await assertExists(path.join(result.packagePath, '.dork/adapters'));

      // When `adapterType` is not provided, the scaffolder defaults it to the
      // package name so the manifest still passes schema validation. The user
      // is expected to edit it after scaffolding.
      const manifest = (await readJson(
        path.join(result.packagePath, PACKAGE_MANIFEST_PATH)
      )) as Record<string, unknown>;
      expect(manifest.type).toBe('adapter');
      expect(manifest.adapterType).toBe('test-adapter');
    });

    it('uses an explicit adapterType when provided', async () => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: 'my-slack-adapter',
        type: 'adapter',
        adapterType: 'slack',
      });

      const manifest = (await readJson(
        path.join(result.packagePath, PACKAGE_MANIFEST_PATH)
      )) as Record<string, unknown>;
      expect(manifest.adapterType).toBe('slack');
    });

    it('ignores adapterType for non-adapter package types', async () => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: 'plugin-with-stray-adapter-type',
        type: 'plugin',
        adapterType: 'should-be-ignored',
      });

      const manifest = (await readJson(
        path.join(result.packagePath, PACKAGE_MANIFEST_PATH)
      )) as Record<string, unknown>;
      expect(manifest.type).toBe('plugin');
      expect(manifest).not.toHaveProperty('adapterType');
    });
  });

  describe('collision protection', () => {
    it('refuses to overwrite an existing directory', async () => {
      const parentDir = await tempDir();
      const collisionPath = path.join(parentDir, 'already-here');
      await fs.mkdir(collisionPath, { recursive: true });

      await expect(
        createPackage({ parentDir, name: 'already-here', type: 'plugin' })
      ).rejects.toThrow(/already exists/);
    });
  });

  describe('round-trip with validatePackage', () => {
    // All four package types round-trip cleanly. The adapter case relies on
    // the scaffolder defaulting `adapterType` to the package name when an
    // explicit value isn't provided.
    const roundTripTypes: readonly PackageType[] = ['plugin', 'skill-pack', 'agent', 'adapter'];

    it.each(roundTripTypes)('createPackage(%s) -> validatePackage passes', async (type) => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: `roundtrip-${type}`,
        type,
      });

      const validation = await validatePackage(result.packagePath);

      expect(validation.issues.filter((i) => i.level === 'error')).toEqual([]);
      expect(validation.ok).toBe(true);
      expect(validation.manifest).toBeDefined();
      expect(validation.manifest?.name).toBe(`roundtrip-${type}`);
      expect(validation.manifest?.type).toBe(type);
    });
  });

  describe('default layers per type', () => {
    const layerExpectations: ReadonlyArray<readonly [PackageType, readonly string[]]> = [
      ['plugin', ['skills', 'extensions']],
      ['skill-pack', ['skills']],
      ['adapter', ['adapters']],
      ['agent', ['skills', 'tasks', 'agents']],
    ];

    it.each(layerExpectations)(
      'writes the documented default layers for %s packages',
      async (type, expectedLayers) => {
        const parentDir = await tempDir();

        const result = await createPackage({
          parentDir,
          name: `layers-${type}`,
          type,
        });

        const manifest = (await readJson(path.join(result.packagePath, PACKAGE_MANIFEST_PATH))) as {
          layers: string[];
        };

        expect(manifest.layers).toEqual(expectedLayers);
      }
    );
  });

  describe('description handling', () => {
    it('uses opts.description when provided', async () => {
      const parentDir = await tempDir();
      const customDescription = 'A bespoke description for our test package';

      const result = await createPackage({
        parentDir,
        name: 'described-pkg',
        type: 'plugin',
        description: customDescription,
      });

      const manifest = (await readJson(path.join(result.packagePath, PACKAGE_MANIFEST_PATH))) as {
        description: string;
      };

      expect(manifest.description).toBe(customDescription);
    });

    it('falls back to a default description when none is provided', async () => {
      const parentDir = await tempDir();

      const result = await createPackage({
        parentDir,
        name: 'undescribed-pkg',
        type: 'skill-pack',
      });

      const manifest = (await readJson(path.join(result.packagePath, PACKAGE_MANIFEST_PATH))) as {
        description: string;
      };

      expect(manifest.description).toBe('undescribed-pkg — a DorkOS skill-pack');
    });
  });
});
