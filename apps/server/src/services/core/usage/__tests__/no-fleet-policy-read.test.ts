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
import { readdir, readFile } from 'node:fs/promises';
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

async function sourceFiles(relDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(REPO_ROOT, relDir), { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (!skipped(rel)) out.push(...(await sourceFiles(rel)));
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
async function offenders(files: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(REPO_ROOT, file), 'utf-8');
    if (!text.includes('fleet.json')) continue;
    const { code } = lexWithoutComments(text, file);
    if (FLEET_POLICY_LITERAL.test(code)) hits.push(file);
  }
  return hits;
}

describe('invariant 4: core never reads flow’s fleet policy', () => {
  it('no server, client or shared source names fleet.json as a string', async () => {
    const files = (await Promise.all(ROOTS.map(sourceFiles))).flat();
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
