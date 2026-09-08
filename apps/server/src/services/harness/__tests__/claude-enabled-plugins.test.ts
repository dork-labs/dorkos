/**
 * SRC-08 and HK-14's user half: what DorkOS reads out of Claude Code's own
 * settings, and how each plugin a person turned on is classified.
 *
 * Every fixture is a temp directory standing in for a Claude root, a repository
 * and a DorkOS data directory. No home directory is read by any case here, which
 * is the point of `readClaudeOnlyPlugins` taking both roots as arguments — the
 * one case that exercises the resolver stubs `$CLAUDE_CONFIG_DIR` at a temp root
 * instead.
 *
 * The sixteen-entry fixture is the operator's real `~/.claude/settings.json` as
 * measured on 2026-09-08: sixteen entries, nine of them `true`, across three
 * marketplace names of which two are declared.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectClaudeOnlyPlugins, readClaudeOnlyPlugins } from '../claude-enabled-plugins.js';

/** The account config `resolveActiveClaudeRoot()` would read, set per case. */
let stubbedRuntimes: unknown;

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'runtimes' ? stubbedRuntimes : undefined) },
}));

/** A fresh temp directory for one fixture. */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-claude-only-'));
}

/** Write `value` as JSON at `file`, creating its parent directories. */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** The two marketplaces the operator's Claude Code declares. */
const KNOWN_MARKETPLACES = {
  'claude-plugins-official': {
    source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
  },
  dorkos: { source: { source: 'github', repo: 'dork-labs/marketplace' } },
};

/** The operator's sixteen entries, nine `true`, as measured on 2026-09-08. */
const SIXTEEN_ENTRIES: Record<string, boolean> = {
  'frontend-design@claude-plugins-official': true,
  'context7@claude-plugins-official': true,
  'code-simplifier@claude-plugins-official': true,
  'feature-dev@claude-plugins-official': false,
  'playwright@claude-plugins-official': true,
  'typescript-lsp@claude-plugins-official': true,
  'claude-md-management@claude-plugins-official': false,
  'skill-creator@claude-plugins-official': true,
  'agent-sdk-dev@claude-plugins-official': false,
  'hookify@claude-plugins-official': false,
  'vercel@claude-plugins-official': false,
  'posthog@claude-plugins-official': false,
  'chrome-devtools-mcp@claude-plugins-official': false,
  'mcp-server-dev@claude-plugins-official': true,
  'persona-toolkit@dork-labs': true,
  'code-reviewer@dorkos': true,
};

/** Stage `<claudeRoot>/settings.json`. */
function writeClaudeSettings(claudeRoot: string, settings: unknown): void {
  writeJson(path.join(claudeRoot, 'settings.json'), settings);
}

/** Stage `<dorkHome>/marketplaces.json` with the sources DorkOS has configured. */
function writeDorkosSources(dorkHome: string, sources: { name: string; source: string }[]): void {
  writeJson(path.join(dorkHome, 'marketplaces.json'), {
    version: 1,
    sources: sources.map((source) => ({
      ...source,
      enabled: true,
      addedAt: '2026-09-08T00:00:00Z',
    })),
  });
}

/** Stage a cached listing for one configured source, as the marketplace cache stores it. */
function writeCachedListing(dorkHome: string, sourceName: string, packages: string[]): void {
  const dir = path.join(dorkHome, 'cache', 'marketplace', 'marketplaces', sourceName);
  writeJson(path.join(dir, 'marketplace.json'), {
    name: sourceName,
    owner: { name: 'fixture' },
    plugins: packages.map((name) => ({ name, source: `./plugins/${name}` })),
  });
  fs.writeFileSync(path.join(dir, '.last-fetched'), new Date().toISOString());
}

describe('what Claude Code alone has', () => {
  let claudeRoot: string;
  let repo: string;
  let dorkHome: string;

  beforeEach(() => {
    claudeRoot = tempDir();
    repo = tempDir();
    dorkHome = tempDir();
    stubbedRuntimes = undefined;
    writeDorkosSources(dorkHome, [
      { name: 'dorkos-community', source: 'https://github.com/dork-labs/marketplace' },
      {
        name: 'claude-plugins-official',
        source: 'https://github.com/anthropics/claude-plugins-official',
      },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [claudeRoot, repo, dorkHome]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Run the read against the three staged directories. */
  const read = async () => readClaudeOnlyPlugins({ claudeRoot, projectPath: repo, dorkHome });

  // Case 1. Seeded defect: report every entry rather than the `true` ones, and
  // this reads sixteen rows instead of nine.
  it('SRC-08: reports the nine plugins turned on out of sixteen, and none of the seven turned off', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: SIXTEEN_ENTRIES,
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });

    const result = await read();

    expect(result.plugins).toHaveLength(9);
    expect(result.plugins.map((plugin) => plugin.name).sort()).toEqual([
      'code-reviewer',
      'code-simplifier',
      'context7',
      'frontend-design',
      'mcp-server-dev',
      'persona-toolkit',
      'playwright',
      'skill-creator',
      'typescript-lsp',
    ]);
    expect(result.plugins.map((plugin) => plugin.name)).not.toContain('feature-dev');
    expect(result.root).toBe(claudeRoot);
    expect(result.unreadable).toBeUndefined();
    // Fifteen of the sixteen resolve to a repository; `dork-labs` is the
    // marketplace Claude Code's public half never declared.
    const unresolved = result.plugins.filter((plugin) => plugin.repo === undefined);
    expect(unresolved.map((plugin) => plugin.name)).toEqual(['persona-toolkit']);
    expect(unresolved[0]?.offer).toBe('unknown-source');
  });

  // Case 2. Seeded defect: replace the Zod parse with a bare `JSON.parse` and a
  // cast, matching `loadClaudeHooks`, and this case throws instead of recording.
  it('SRC-08: turns a malformed settings file into one record rather than a throw', async () => {
    fs.writeFileSync(path.join(claudeRoot, 'settings.json'), '{ "enabledPlugins": {,,, ');

    const result = await read();

    expect(result.unreadable).toBeTruthy();
    expect(result.plugins).toEqual([]);
    expect(result.personalHookCommands).toBe(0);
    expect(result.root).toBe(claudeRoot);
  });

  it('SRC-08: records a settings file whose shape the slice cannot accept, and still does not throw', async () => {
    writeClaudeSettings(claudeRoot, { enabledPlugins: { 'a@b': 'not-a-boolean' } });

    const result = await read();

    expect(result.unreadable).toBe('enabledPlugins.a@b is not a shape DorkOS can read');
    expect(result.plugins).toEqual([]);
    // The reason says WHERE and never WHAT. Zod's own message quotes the value
    // it rejected, and this is somebody's private settings file.
    expect(result.unreadable).not.toContain('not-a-boolean');
  });

  // Case 3. Seeded defect: call `resolveActiveClaudeRoot()` instead, and the
  // `defaultAccount` staged below is the root that gets read and printed.
  it('SRC-08: reads the root a bare claude uses, not the account DorkOS bills', async () => {
    const billedRoot = tempDir();
    writeClaudeSettings(billedRoot, {
      enabledPlugins: { 'billing-only@claude-plugins-official': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'context7@claude-plugins-official': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });
    stubbedRuntimes = { claudeCode: { defaultAccount: billedRoot, accounts: [] } };
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeRoot);

    try {
      const result = await collectClaudeOnlyPlugins({ projectPath: repo, dorkHome });

      expect(result.root).toBe(claudeRoot);
      expect(result.plugins.map((plugin) => plugin.name)).toEqual(['context7']);
    } finally {
      fs.rmSync(billedRoot, { recursive: true, force: true });
    }
  });

  // Case 4. Seeded defect: match on the marketplace name, and this pair —
  // Claude Code's `dorkos` against DorkOS's `dorkos-community`, one repository
  // under two local names — falls to "cannot tell where this came from".
  it('SRC-08: matches a marketplace on its repository, so two local names for one repo resolve', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'code-reviewer@dorkos': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });
    writeCachedListing(dorkHome, 'dorkos-community', ['code-reviewer', 'flow']);

    const result = await read();

    expect(result.plugins).toEqual([
      {
        name: 'code-reviewer',
        marketplace: 'dorkos',
        repo: 'dork-labs/marketplace',
        settingsScope: 'user',
        offer: 'install',
      },
    ]);
  });

  it('SRC-08: offers the source before the install when DorkOS does not have that repository', async () => {
    writeDorkosSources(dorkHome, []);
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'code-reviewer@dorkos': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });

    const result = await read();

    expect(result.plugins[0]).toMatchObject({
      offer: 'add-source-then-install',
      sourceUrl: 'https://github.com/dork-labs/marketplace',
    });
  });

  // Case 5. Seeded defect: return the install offer anyway, and this case sees
  // `dorkos install` beside a package the listing says is not there.
  it('SRC-08: says a resolved source has nothing by that name, and offers no command', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'not-published-here@dorkos': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });
    writeCachedListing(dorkHome, 'dorkos-community', ['code-reviewer', 'flow']);

    const result = await read();

    expect(result.plugins[0]).toMatchObject({
      name: 'not-published-here',
      repo: 'dork-labs/marketplace',
      offer: 'no-package',
    });
    expect(result.plugins[0]?.sourceUrl).toBeUndefined();
  });

  it('SRC-08: never claims a package is missing from a source nobody has listed', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'not-published-here@dorkos': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });

    const result = await read();

    expect(result.plugins[0]?.offer).toBe('install');
  });

  // Case 6. Seeded defect: read the user file only, and a plugin somebody turned
  // off for this repository appears in the machine-wide list with an install
  // command beside it.
  it('SRC-08: leaves out a plugin turned off in .claude/settings.local.json', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: {
        'context7@claude-plugins-official': true,
        'playwright@claude-plugins-official': true,
      },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });
    writeJson(path.join(repo, '.claude', 'settings.local.json'), {
      enabledPlugins: { 'playwright@claude-plugins-official': false },
    });

    const result = await read();

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(['context7']);
  });

  // Case 7. Seeded defect: merge project entries into the machine-wide list, and
  // this plugin lands under the wrong heading.
  it('SRC-08: marks a plugin true only in the project file as on for this project only', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'context7@claude-plugins-official': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });
    writeJson(path.join(repo, '.claude', 'settings.json'), {
      enabledPlugins: { 'playwright@claude-plugins-official': true },
    });

    const result = await read();

    const scopes = Object.fromEntries(
      result.plugins.map((plugin) => [plugin.name, plugin.settingsScope])
    );
    expect(scopes).toEqual({ context7: 'user', playwright: 'project' });
  });

  it('SRC-08: counts a plugin the user file turns off and the project turns on as project only', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'playwright@claude-plugins-official': false },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });
    writeJson(path.join(repo, '.claude', 'settings.json'), {
      enabledPlugins: { 'playwright@claude-plugins-official': true },
    });

    const result = await read();

    expect(result.plugins.map((plugin) => plugin.settingsScope)).toEqual(['project']);
  });

  // Case 8. Seeded defect: count matcher groups instead of entries, and the
  // count reads 2 where this fixture runs 3 commands.
  it('HK-14: counts the hook commands the personal settings file runs, entries and not groups', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'context7@claude-plugins-official': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'one' },
              { type: 'command', command: 'two' },
            ],
          },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'three' }] }],
      },
    });

    expect((await read()).personalHookCommands).toBe(3);
  });

  it('HK-14: counts zero when the personal settings file declares no hooks', async () => {
    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'context7@claude-plugins-official': true },
      extraKnownMarketplaces: KNOWN_MARKETPLACES,
    });

    expect((await read()).personalHookCommands).toBe(0);
  });

  // Case 9. Seeded defect: report something unconditionally, and a machine with
  // nothing turned on gets a block with no content in it.
  it('SRC-08: reports nothing at all when no plugin is turned on', async () => {
    writeClaudeSettings(claudeRoot, { enabledPlugins: {} });
    expect((await read()).plugins).toEqual([]);

    writeClaudeSettings(claudeRoot, { theme: 'dark' });
    expect((await read()).plugins).toEqual([]);

    writeClaudeSettings(claudeRoot, {
      enabledPlugins: { 'context7@claude-plugins-official': false },
    });
    expect((await read()).plugins).toEqual([]);
  });

  it('SRC-08: says nothing about a Claude root that has no settings file at all', async () => {
    const result = await read();

    expect(result.plugins).toEqual([]);
    expect(result.unreadable).toBeUndefined();
    expect(result.mayBeOverridden).toBe(true);
  });
});
