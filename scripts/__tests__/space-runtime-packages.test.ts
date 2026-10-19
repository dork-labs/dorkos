/**
 * What the space image installs (server-merge step 7f, scripts/space-image/runtime-packages.mjs):
 * the unused SQLite driver is pruned, and an image that installs the machine store, a runtime
 * SDK, a terminal or the DorkOS server is refused at build time.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { forbiddenInstalled, installedPackages, prune } from '../space-image/runtime-packages.mjs';

const script = join(import.meta.dirname, '../space-image/runtime-packages.mjs');

/** A deployed folder as `pnpm deploy` lays it out: the store, its links, and top-level links. */
function deployed(store: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'space-image-'));
  const pnpm = join(dir, 'node_modules/.pnpm');
  for (const [folder, links] of Object.entries(store)) {
    const name = folder
      .slice(0, folder.indexOf('@', folder.startsWith('@') ? 1 : 0))
      .replace('+', '/');
    const own = join(pnpm, folder, 'node_modules', name);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'package.json'), JSON.stringify({ name }));
    for (const link of links) {
      const target = Object.keys(store).find((other) =>
        other.startsWith(`${link.replace('/', '+')}@`)
      );
      const at = join(pnpm, folder, 'node_modules', link);
      mkdirSync(join(at, '..'), { recursive: true });
      symlinkSync(join(pnpm, target ?? `${link}@missing`, 'node_modules', link), at);
    }
  }
  return dir;
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

describe('the space image packages', () => {
  it('finds the SQLite driver drizzle-orm brings in, and prunes it with its link', () => {
    // Purpose: fails if the optional peer goes unseen, or pruning leaves the package or a link
    // to it behind.
    const dir = deployed({
      'better-sqlite3@12.11.1': [],
      'drizzle-orm@0.45.3_better-sqlite3@12.11.1': ['better-sqlite3'],
      'pg@8.23.0': [],
    });
    expect(forbiddenInstalled(dir)).toEqual(['better-sqlite3 (the machine store)']);
    prune(dir);
    expect(forbiddenInstalled(dir)).toEqual([]);
    const drizzle = join(dir, 'node_modules/.pnpm/drizzle-orm@0.45.3_better-sqlite3@12.11.1');
    expect(exists(join(drizzle, 'node_modules/better-sqlite3'))).toBe(false);
    expect(existsSync(join(drizzle, 'node_modules/drizzle-orm/package.json'))).toBe(true);
    expect(installedPackages(dir)).toEqual(new Set(['drizzle-orm', 'pg']));
  });

  it('refuses what it may not prune', () => {
    // Purpose: fails if a runtime SDK, the terminal or the DorkOS server could be installed.
    const dir = deployed({ 'node-pty@1.0.0': [], '@openai+codex-sdk@0.1.0': [], 'pg@8.23.0': [] });
    prune(dir);
    expect(forbiddenInstalled(dir)).toEqual([
      '@openai/codex-sdk (a runtime SDK)',
      'node-pty (the terminal)',
    ]);
    const run = spawnSync(process.execPath, [script, dir, '--prune'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('The space image must not install:');
  });

  it('refuses to pass a folder with nothing installed', () => {
    // Purpose: fails if a wrong folder (nothing deployed there) would pass as clean.
    const run = spawnSync(process.execPath, [script, mkdtempSync(join(tmpdir(), 'empty-'))], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('nothing was checked');
  });
});
