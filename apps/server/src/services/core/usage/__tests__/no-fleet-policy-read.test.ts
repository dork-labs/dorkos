/**
 * Invariant 4 of spec `claude-account-ui` (§4, §12): DorkOS core never reads
 * flow's fleet policy. The policy is the Flow extension's own file; core learns
 * what flow decided only through the account advisor, so no source in the
 * server, the client or the shared package may name `fleet.json` as a string.
 *
 * A string scan, over every non-test `.ts`/`.tsx` file, with comments blanked
 * (prose may explain the rule) and string literals kept (the literal is the
 * thing that would open the file). The vendored conformance fixtures under
 * `packages/shared/src/__fixtures__/` are flow's own and are skipped.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lexWithoutComments } from '../../../../../../../scripts/lib/code-only.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../..'
);

/** The trees core ships from. */
const ROOTS = ['apps/server/src', 'apps/client/src', 'packages/shared/src'];

/** A directory whose files are never scanned: tests, and flow's vendored fixtures. */
function skipped(relDir: string): boolean {
  const name = path.basename(relDir);
  return name === '__tests__' || relDir === 'packages/shared/src/__fixtures__';
}

/** A file this guard reads: TypeScript source that is not a test. */
function scanned(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts');
}

async function sourceFiles(relDir: string, root = REPO_ROOT): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, relDir), { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (!skipped(rel)) out.push(...(await sourceFiles(rel, root)));
    } else if (scanned(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** A quoted `fleet.json` string literal, in either quote. */
const FLEET_POLICY_LITERAL = /'fleet\.json'|"fleet\.json"/;

/**
 * The files among `files` whose code (comments blanked) holds the literal.
 *
 * @param files - Repo-relative paths.
 */
async function offenders(files: readonly string[], root = REPO_ROOT): Promise<string[]> {
  const hits = await readSourcesInOrder(files, async (file) => {
    const text = await readFile(path.join(root, file), 'utf-8');
    if (!text.includes('fleet.json')) return undefined;
    const { code } = lexWithoutComments(text, file);
    return FLEET_POLICY_LITERAL.test(code) ? file : undefined;
  });
  return hits.filter((file): file is string => file !== undefined);
}

/** Read at most eight sources at once, retaining input order and draining failures. */
async function readSourcesInOrder<T>(
  files: readonly string[],
  read: (file: string) => Promise<T>
): Promise<T[]> {
  const results: ({ ok: true; value: T } | { ok: false; error: unknown })[] = new Array(
    files.length
  );
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      try {
        results[index] = { ok: true, value: await read(files[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, () => worker()));
  return results.map((result) => {
    if (!result.ok) throw result.error;
    return result.value;
  });
}

describe('invariant 4: core never reads flow’s fleet policy', () => {
  it('no server, client or shared source names fleet.json as a string', async () => {
    const files = (await Promise.all(ROOTS.map((root) => sourceFiles(root)))).flat();
    // A scan that found nothing to read would pass for a clean one.
    expect(files.length).toBeGreaterThan(500);
    expect(await offenders(files)).toEqual([]);
  });

  it('sees a literal in code, and not the same words in a comment', () => {
    const lexed = (source: string) => lexWithoutComments(source, 'probe.ts').code;
    expect(FLEET_POLICY_LITERAL.test(lexed(`const p = join(dir, 'fleet.json');`))).toBe(true);
    expect(FLEET_POLICY_LITERAL.test(lexed('const p = join(dir, "fleet.json");'))).toBe(true);
    expect(FLEET_POLICY_LITERAL.test(lexed(`// core never opens 'fleet.json'`))).toBe(false);
    expect(FLEET_POLICY_LITERAL.test(lexed(`/** never 'fleet.json' */ const x = 1;`))).toBe(false);
  });
});

describe('bounded source reads', () => {
  it('keeps every result in input order with eight reads and drains a delayed first input', async () => {
    const files = Array.from({ length: 33 }, (_, index) => `${index}`);
    let active = 0;
    let peak = 0;
    const finished: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pending = readSourcesInOrder(files, async (file) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await (file === '0' ? first : Promise.resolve());
        finished.push(file);
        return file;
      } finally {
        active--;
      }
    });
    let settled = false;
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      expect(active).toBe(8);
      // Let the other workers finish while the first input remains held.
      for (let turn = 0; turn < 32; turn++) await Promise.resolve();
      expect(finished).toHaveLength(32);
      expect(finished).not.toContain('0');
      expect(settled).toBe(false);
    } finally {
      releaseFirst();
      await observed;
    }
    expect(await pending).toEqual(files);
    expect(finished).toHaveLength(33);
    expect(active).toBe(0);
    expect(peak).toBe(8);
  });

  it.each([new Error('first input error'), undefined])(
    'throws the earliest input failure unchanged and drains every task (%s)',
    async (firstError) => {
      const files = Array.from({ length: 24 }, (_, index) => `${index}`);
      const laterError = new Error('later input error');
      let finished = 0;
      let caught = false;
      let actual: unknown;
      let releaseError!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseError = resolve;
      });
      const pending = readSourcesInOrder(files, async (file) => {
        try {
          await (file === '2' ? first : Promise.resolve());
          if (file === '2') throw firstError;
          if (file === '7') throw laterError;
          return file;
        } finally {
          finished++;
        }
      });
      // Register the observer before releasing either error; undefined is still a failure.
      const observed = pending.then(
        () => {},
        (error: unknown) => {
          caught = true;
          actual = error;
        }
      );
      try {
        await Promise.resolve();
      } finally {
        releaseError();
        await observed;
      }
      expect(caught).toBe(true);
      expect(actual).toBe(firstError);
      expect(finished).toBe(24);
    }
  );
});

describe('independent fleet source fixtures', () => {
  it('retains the complete path set, exact exclusions, symlinks and late literal classification', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fleet-source-guard-'));
    const clean = 'export const value = 1;';
    const fixtures: Record<string, string> = {
      'apps/server/src/a.ts': clean,
      'apps/server/src/.hidden/keep.ts': clean,
      'apps/server/src/dist/keep.ts': clean,
      'apps/server/src/node_modules/keep.ts': clean,
      'apps/server/src/.turbo/keep.ts': clean,
      'apps/server/src/__fixtures__/keep.ts': clean,
      'apps/server/src/__tests__/skip.ts': "const p = 'fleet.json';",
      'apps/server/src/a.test.ts': "const p = 'fleet.json';",
      'apps/server/src/a.spec.tsx': "const p = 'fleet.json';",
      'apps/server/src/a.d.ts': "declare const p: 'fleet.json';",
      'apps/client/src/comment.ts': "// never opens 'fleet.json'\nconst emoji = '😀';",
      'apps/client/src/jsx.tsx': 'export const view = <div title="fleet.json" />;',
      'apps/client/src/jsx-fallback.ts': 'export const view = <div title="fleet.json" />;',
      'packages/shared/src/__fixtures__/skip.ts': "const p = 'fleet.json';",
      'packages/shared/src/other/__fixtures__/keep.ts': clean,
      'packages/shared/src/z-last/nested.ts': "const p = 'fleet.json';",
    };
    try {
      for (const [file, text] of Object.entries(fixtures)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
      }
      await symlink(
        path.join(root, 'apps/server/src/a.ts'),
        path.join(root, 'apps/server/src/alias.ts')
      );
      await symlink(
        path.join(root, 'packages/shared/src/z-last'),
        path.join(root, 'apps/server/src/dir-link'),
        'dir'
      );
      const found = (await Promise.all(ROOTS.map((dir) => sourceFiles(dir, root)))).flat();
      // Manually enumerated: this expected set does not reuse the walker or its filters.
      expect([...found].sort()).toEqual(
        [
          'apps/client/src/comment.ts',
          'apps/client/src/jsx-fallback.ts',
          'apps/client/src/jsx.tsx',
          'apps/server/src/.hidden/keep.ts',
          'apps/server/src/.turbo/keep.ts',
          'apps/server/src/__fixtures__/keep.ts',
          'apps/server/src/a.ts',
          'apps/server/src/alias.ts',
          'apps/server/src/dist/keep.ts',
          'apps/server/src/node_modules/keep.ts',
          'packages/shared/src/other/__fixtures__/keep.ts',
          'packages/shared/src/z-last/nested.ts',
        ].sort()
      );
      expect((await offenders(found, root)).sort()).toEqual(
        [
          'apps/client/src/jsx-fallback.ts',
          'apps/client/src/jsx.tsx',
          'packages/shared/src/z-last/nested.ts',
        ].sort()
      );
      const ordered = [
        'apps/client/src/comment.ts',
        'apps/server/src/a.ts',
        'packages/shared/src/z-last/nested.ts',
      ];
      expect(await offenders(ordered, root)).toEqual(['packages/shared/src/z-last/nested.ts']);
      await expect(offenders(['apps/server/src/a.ts', 'absent.ts'], root)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(sourceFiles('absent', root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
