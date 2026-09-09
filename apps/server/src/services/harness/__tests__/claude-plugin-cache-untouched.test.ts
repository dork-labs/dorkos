/**
 * Position D4, measured rather than asserted: DorkOS reads Claude Code's public
 * settings and NEVER its private plugin cache.
 *
 * Its own file because it needs a module-scope `node:fs/promises` mock, and a
 * suite that records every path anything opens is not a thing to impose on the
 * cases next door. The mock is a pass-through — it records and delegates — so
 * what runs underneath is the real read against a real temp tree, and the
 * recording is evidence about that run rather than about a stub.
 *
 * Why this is worth a test at all. `~/.claude/plugins/` is a private, versioned
 * cache that has already changed format once; `blocklist.json` and the catalog
 * cache are `0600`, and `installed_plugins.json` carries a version field DorkOS
 * does not control. Projecting out of it would also break the one rule the
 * engine's sweep depends on, that it only ever deletes what it wrote. The rule
 * held by discipline and a comment until now, which is the same as not holding:
 * one convenience read of `installed_plugins.json` would look reasonable in a
 * diff and nothing anywhere would notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every path the module under test handed to `node:fs/promises`, in order. */
const opened: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const record = <T extends unknown[], R>(
    fn: (...args: T) => R,
    name: keyof typeof actual
  ): ((...args: T) => R) => {
    void name;
    return (...args: T): R => {
      opened.push(String(args[0]));
      return fn(...args);
    };
  };
  return {
    ...actual,
    default: actual,
    readFile: record(actual.readFile, 'readFile'),
    readdir: record(actual.readdir, 'readdir'),
    open: record(actual.open, 'open'),
    stat: record(actual.stat, 'stat'),
    lstat: record(actual.lstat, 'lstat'),
    realpath: record(actual.realpath, 'realpath'),
  };
});

const { readClaudeOnlyPlugins } = await import('../claude-enabled-plugins.js');

/** A fresh temp directory for one fixture. */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-claude-cache-'));
}

/** The bytes that must never leave the private cache. */
const SECRET = 'ghp_NOT_A_REAL_TOKEN_00000000000000000000';

describe("Claude Code's private plugin cache", () => {
  let claudeRoot: string;
  let repo: string;
  let dorkHome: string;

  beforeEach(() => {
    opened.length = 0;
    claudeRoot = tempDir();
    repo = tempDir();
    dorkHome = tempDir();

    // The public half: a real settings file with a real answer in it, so the
    // read below is the ordinary one and not a degenerate case that touches
    // nothing by accident.
    fs.writeFileSync(
      path.join(claudeRoot, 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'context7@claude-plugins-official': true },
        extraKnownMarketplaces: {
          'claude-plugins-official': {
            source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
          },
        },
      })
    );

    // The private half, shaped like the real one and holding something that
    // would be unmistakable if it ever surfaced.
    const cache = path.join(claudeRoot, 'plugins', 'repos', 'anthropics');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      path.join(claudeRoot, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 3, token: SECRET })
    );
    fs.writeFileSync(path.join(cache, 'private.json'), JSON.stringify({ token: SECRET }));
    fs.writeFileSync(path.join(claudeRoot, 'plugins', 'blocklist.json'), '["nothing"]');
  });

  afterEach(() => {
    for (const dir of [claudeRoot, repo, dorkHome]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Seeded defect: add one read of `<claudeRoot>/plugins/installed_plugins.json`
  // — the convenience that would let the report say "installed" instead of
  // "turned on" — and the path assertion below names it.
  it('SRC-08: is never opened, and nothing in it reaches the answer', async () => {
    const result = await readClaudeOnlyPlugins({ claudeRoot, projectPath: repo, dorkHome });

    // The run really happened, so "nothing was read" is not why this passes.
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(['context7']);
    expect(opened.some((file) => file === path.join(claudeRoot, 'settings.json'))).toBe(true);

    const cacheRoot = path.join(claudeRoot, 'plugins');
    expect(opened.filter((file) => file.startsWith(cacheRoot))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('installed_plugins');
  });
});
