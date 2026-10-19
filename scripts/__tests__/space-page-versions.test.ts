/**
 * The space's web pages build against two installs of their packages (server-merge step 7e):
 * `apps/client`'s, in a checkout, and the space package's, in the image's build stage, which
 * links `apps/client/node_modules` to `apps/community`'s. They must be the same versions, or the
 * image ships a page no local build or test produced.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const fromClient = createRequire(join(root, 'apps/client/package.json'));
const fromImage = createRequire(join(root, 'apps/community/package.json'));
const SPACE = join(root, 'apps/client/src/space');

/** Every package the page's source imports, plus what builds it. */
function pagePackages(): string[] {
  const names = new Set(['vite', '@vitejs/plugin-react', '@tailwindcss/vite', 'tailwindcss']);
  for (const file of readdirSync(SPACE, { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx|css)$/u.test(file)) continue;
    const text = readFileSync(join(SPACE, file), 'utf8');
    for (const [, spec = ''] of text.matchAll(/(?:from|import)\s+['"]([^./'"][^'"]*)['"]/gu)) {
      const parts = spec.split('/');
      names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec));
    }
  }
  // Workspace packages are the same source on both sides, so they cannot drift.
  return [...names]
    .filter((name) => !name.startsWith('node:') && !/^@(dorkos|dork-labs)\//u.test(name))
    .sort();
}

/** The installed version of a package, as one install resolves it, or null when it has none. */
function versionIn(require: NodeJS.Require, name: string): string | null {
  let entry: string;
  try {
    entry = require.resolve(name);
  } catch {
    try {
      entry = require.resolve(`${name}/package.json`);
    } catch {
      return null;
    }
  }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version: string };
    if (json.name === name) return json.version;
  }
  return null;
}

describe("the space page's packages", () => {
  it('resolve to the same versions in a checkout and in the image build', () => {
    // Purpose: fails if a bump in apps/client or apps/community alone (a Dependabot PR, say)
    // leaves the image building the page against versions no local build or test used.
    const names = pagePackages();
    expect(names).toEqual(expect.arrayContaining(['react', 'better-auth', 'lucide-react', 'vite']));
    const drift = names
      .map((name) => ({
        name,
        client: versionIn(fromClient, name),
        image: versionIn(fromImage, name),
      }))
      .filter(({ client, image }) => client === null || client !== image);
    expect(drift).toEqual([]);
  });
});
