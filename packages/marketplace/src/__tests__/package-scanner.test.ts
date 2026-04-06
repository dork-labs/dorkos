import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { scanPackageDirectory } from '../package-scanner.js';
import { PACKAGE_MANIFEST_PATH } from '../constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `marketplace-scanner-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

describe('scanPackageDirectory', () => {
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

  it('returns empty array for an empty directory', async () => {
    const dir = await tempDir();

    const results = await scanPackageDirectory(dir);

    expect(results).toEqual([]);
  });

  it('returns only directories that contain a .dork/manifest.json', async () => {
    const root = await tempDir();

    // A valid package
    await writeJson(path.join(root, 'real-pkg', PACKAGE_MANIFEST_PATH), {
      schemaVersion: 1,
      name: 'real-pkg',
      version: '1.0.0',
      type: 'agent',
      description: 'A real package',
    });

    // A non-package directory (no manifest)
    await fs.mkdir(path.join(root, 'not-a-pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'not-a-pkg', 'README.md'), '# nope', 'utf-8');

    // A regular file at the root — must be ignored
    await fs.writeFile(path.join(root, 'loose-file.txt'), 'ignore me', 'utf-8');

    const results = await scanPackageDirectory(root);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'real-pkg',
      packagePath: path.join(root, 'real-pkg'),
    });
  });

  it('returns all directories with a .dork/manifest.json from the fixtures dir', async () => {
    // The scanner does not validate manifest contents — it only checks for
    // the presence of `.dork/manifest.json`. So `invalid-manifest-shape` is
    // expected to be returned, but `invalid-no-manifest` and
    // `claude-code-plugin` (no .dork/) are not.
    const results = await scanPackageDirectory(FIXTURES_DIR);
    const names = results.map((r) => r.name).sort();

    expect(names).toEqual(
      [
        'invalid-manifest-shape',
        'valid-adapter',
        'valid-agent',
        'valid-plugin',
        'valid-skill-pack',
      ].sort()
    );
    expect(names).not.toContain('invalid-no-manifest');
    expect(names).not.toContain('claude-code-plugin');
  });

  it('does not recurse into nested packages', async () => {
    const root = await tempDir();

    // Outer package
    await writeJson(path.join(root, 'outer', PACKAGE_MANIFEST_PATH), {
      schemaVersion: 1,
      name: 'outer',
      version: '1.0.0',
      type: 'agent',
      description: 'outer',
    });

    // Nested package inside the outer one — should NOT be discovered
    await writeJson(path.join(root, 'outer', 'nested', PACKAGE_MANIFEST_PATH), {
      schemaVersion: 1,
      name: 'nested',
      version: '1.0.0',
      type: 'agent',
      description: 'nested',
    });

    const results = await scanPackageDirectory(root);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('outer');
  });
});
