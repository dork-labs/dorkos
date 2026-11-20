/** Independent coverage and scheduling controls for the credential source guard. */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialReach, readSourcesInOrder, sourceFiles } from './administer-source-guard.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'administer-source-guard-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function put(file: string, text: string): Promise<void> {
  await mkdir(join(root, file, '..'), { recursive: true });
  await writeFile(join(root, file), text);
}

/** Independent reference: the original interleaved serial walk and raw-text classifier. */
async function serial(
  dir = root
): Promise<{ files: string[]; module: string[]; accessor: string[] }> {
  const found = { files: [] as string[], module: [] as string[], accessor: [] as string[] };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        const child = await serial(file);
        for (const key of ['files', 'module', 'accessor'] as const) found[key].push(...child[key]);
      }
    } else if (/\.tsx?$/u.test(entry.name)) {
      const text = await readFile(file, 'utf8');
      const rel = relative(root, file);
      found.files.push(rel);
      if (/administer-credentials(\.js)?['"]/u.test(text)) found.module.push(rel);
      if (/\bgetRemoteAdministerCredentials\b/u.test(text)) found.accessor.push(rel);
    }
  }
  return found;
}

it('preserves exact subjects and raw-text hits, including late TSX and source links', async () => {
  const fixtures: Record<string, string> = {
    '.hidden/keep.ts': 'export const clean = 1;',
    'dist/keep.ts': 'export const clean = 1;',
    '__fixtures__/keep.ts': 'export const clean = 1;',
    '__tests__/skip.ts': "import 'administer-credentials.js';",
    'node_modules/skip.tsx': 'getRemoteAdministerCredentials()',
    'a.test.ts': "import 'administer-credentials';",
    'b.spec.tsx': 'getRemoteAdministerCredentials()',
    'c.d.ts': "// administer-credentials.js'",
    'd.ts': 'getRemoteAdministerCredentialsExtra(); _getRemoteAdministerCredentials();',
    'e.ts': 'const benign = "administer-credentials.jsx";',
    'f.ts': '// getRemoteAdministerCredentials',
    'g.tsx': 'export const view = <div />;',
    'ignored.js': "import 'administer-credentials.js';",
    'z-last/nested/offender.tsx':
      'import "administer-credentials.js"; getRemoteAdministerCredentials();',
  };
  for (const [file, text] of Object.entries(fixtures)) await put(file, text);
  await symlink(join(root, 'a.test.ts'), join(root, 'alias.ts'));
  await symlink(join(root, 'z-last'), join(root, 'directory-link'), 'dir');
  const expectedFiles = [
    '.hidden/keep.ts',
    '__fixtures__/keep.ts',
    'a.test.ts',
    'alias.ts',
    'b.spec.tsx',
    'c.d.ts',
    'd.ts',
    'dist/keep.ts',
    'e.ts',
    'f.ts',
    'g.tsx',
    'z-last/nested/offender.tsx',
  ].sort();
  const files = await sourceFiles(root);
  expect(files.map((file) => relative(root, file)).sort()).toEqual(expectedFiles);
  const read: string[] = [];
  const found = await credentialReach(root, files, async (file) => {
    read.push(relative(root, file));
    return readFile(file, 'utf8');
  });
  expect(read.sort()).toEqual(expectedFiles);
  expect(found.module.sort()).toEqual([
    'a.test.ts',
    'alias.ts',
    'c.d.ts',
    'z-last/nested/offender.tsx',
  ]);
  expect(found.accessor.sort()).toEqual(['b.spec.tsx', 'f.ts', 'z-last/nested/offender.tsx']);
  const original = await serial();
  expect(original.files.sort()).toEqual(expectedFiles);
  expect(found).toEqual({ module: original.module.sort(), accessor: original.accessor.sort() });
});

it('keeps classification in input order and overlaps the actual scanner without a clock', async () => {
  const files = Array.from({ length: 25 }, (_, index) => join(root, `${index}.tsx`));
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished: string[] = [];
  const pending = credentialReach(root, files, async (file) => {
    active++;
    peak = Math.max(peak, active);
    try {
      if (file === files[0]) await held;
      else await Promise.resolve();
      finished.push(file);
      return "import 'administer-credentials.js'; getRemoteAdministerCredentials();";
    } finally {
      active--;
    }
  });
  let settled = false;
  const observed = pending.finally(() => {
    settled = true;
  });
  try {
    for (let turn = 0; turn < 64; turn++) await Promise.resolve();
    // The serial implementation reaches this assertion without hanging, and fails it.
    expect(peak).toBe(8);
    expect(finished).toHaveLength(24);
    expect(active).toBe(1);
    expect(settled).toBe(false);
  } finally {
    release();
    await observed;
  }
  const expected = files.map((file) => relative(root, file));
  expect(await pending).toEqual({ module: expected, accessor: expected });
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  expect(active).toBe(0);
});

it.each([new Error('first content failure'), undefined])(
  'drains every content read and throws the earliest input failure unchanged (%s)',
  async (first) => {
    const files = Array.from({ length: 25 }, (_, index) => join(root, `${index}.ts`));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished: string[] = [];
    let settled = false;
    const pending = credentialReach(root, files, async (file) => {
      try {
        if (file === files[2]) {
          await held;
          throw first;
        }
        if (file === files[10]) throw new Error('later input failed first');
        return '';
      } finally {
        finished.push(file);
      }
    });
    const observed = pending
      .then(
        () => ({ rejected: false, error: undefined }),
        (error) => ({ rejected: true, error })
      )
      .finally(() => {
        settled = true;
      });
    try {
      for (let turn = 0; turn < 64; turn++) await Promise.resolve();
      expect(finished).toHaveLength(24);
      expect(settled).toBe(false);
    } finally {
      release();
    }
    expect(await observed).toEqual({ rejected: true, error: first });
    expect(finished.sort()).toEqual([...files].sort());
  }
);

describe('fail-closed filesystem subjects', () => {
  it('rejects missing sources in both serial and bounded scans', async () => {
    await symlink(join(root, 'missing.ts'), join(root, 'broken.ts'));
    const files = await sourceFiles(root);
    expect(files).toEqual([join(root, 'broken.ts')]);
    await expect(serial()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(credentialReach(root, files)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(sourceFiles(join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not traverse directory links but still rejects a directory link named .ts', async () => {
    await put('target/inside.ts', 'getRemoteAdministerCredentials()');
    await symlink(join(root, 'target'), join(root, 'ordinary-link'), 'dir');
    expect((await sourceFiles(root)).map((file) => relative(root, file))).toEqual([
      'target/inside.ts',
    ]);
    await symlink(join(root, 'target'), join(root, 'directory.ts'), 'dir');
    expect((await sourceFiles(root)).map((file) => relative(root, file)).sort()).toEqual([
      'directory.ts',
      'target/inside.ts',
    ]);
    await expect(serial()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(credentialReach(root, await sourceFiles(root))).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
  it('represents an empty fixture honestly and does not invoke a reader for it', async () => {
    expect(await sourceFiles(root)).toEqual([]);
    expect(
      await readSourcesInOrder([], async () => {
        throw new Error('unexpected read');
      })
    ).toEqual([]);
    expect(await serial()).toEqual({ files: [], module: [], accessor: [] });
  });
});
