import { describe, it, expect } from 'vitest';
import {
  declaredEffectPaths,
  isReservedPackagePath,
  matchesUserEditable,
  UserEditablePathSchema,
  validUserEditable,
} from '../user-editable.js';
import { MarketplacePackageManifestSchema } from '../manifest-schema.js';

describe('isReservedPackagePath', () => {
  // Purpose: the paths DorkOS keeps for the person or the installer must be
  // recognised wherever they sit, so no package can ship over them.
  it.each([
    '.dork/data',
    '.dork/data/x/y.json',
    '.dork/secrets.json',
    '.dork/install-metadata.json',
    '.dork/installed-files.json',
    '.dork/uninstalled-agent.json',
    'skills/x/SKILL.md.dork-old',
    'config/defaults.json.dork-new',
    'x.dork-new.3',
    'x.dork-old.12',
  ])('reserves %s', (p) => {
    expect(isReservedPackagePath(p)).toBe(true);
  });

  // Purpose (code review 2): a case-insensitive volume (APFS, NTFS) treats these
  // as the reserved paths themselves, so they must be reserved as well,
  // including a compatibility spelling (U+017F folds to "s").
  it.each([
    '.dork/Secrets.json',
    '.DORK/secrets.json',
    '.dork/Data',
    '.dork/DATA/seed.json',
    '.dork/Installed-Files.json',
    'x.DORK-OLD',
    'x.Dork-New.2',
    '.dork/\u017Fecrets.json',
  ])('reserves the case variant %s', (p) => {
    expect(isReservedPackagePath(p)).toBe(true);
  });

  // Purpose: near-misses must stay shippable, or a real package file is dropped.
  it.each([
    '.dork/database.json',
    '.dork/dataset/x',
    'x.dork-older',
    'x.dork-old.2b',
    'dork-old',
    'skills/x/SKILL.md',
    '.dork/manifest.json',
  ])('does not reserve %s', (p) => {
    expect(isReservedPackagePath(p)).toBe(false);
  });
});

describe('UserEditablePathSchema', () => {
  // Purpose: the two supported forms parse.
  it.each(['config/defaults.json', 'prompts/**', 'README.md'])('accepts %s', (p) => {
    expect(UserEditablePathSchema.safeParse(p).success).toBe(true);
  });

  // Purpose: every form outside the tiny subset, and every path the person or
  // the package identity owns, is refused with a message.
  it.each([
    ['', 'empty'],
    ['/abs/x', 'absolute'],
    ['../x', 'parent'],
    ['a/../b', 'parent'],
    ['a\\b', 'backslash'],
    ['./a', 'leading ./'],
    ['*.json', 'wildcard'],
    ['dir/*', 'wildcard'],
    ['a?b', 'wildcard'],
    ['.dork/data/**', 'reserved'],
    ['.dork/secrets.json', 'reserved'],
    ['.dork/**', 'reserved'],
    ['.dork/manifest.json', 'identity'],
    ['.claude-plugin/plugin.json', 'identity'],
    ['.claude-plugin/**', 'identity'],
  ])('refuses %s (%s)', (p) => {
    const result = UserEditablePathSchema.safeParse(p);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message.length).toBeGreaterThan(0);
  });
});

describe('matchesUserEditable', () => {
  // Purpose: exact paths match only themselves; prefixes match only beneath.
  it('matches exact paths and dir/** prefixes, never siblings that share a prefix', () => {
    const patterns = ['config/defaults.json', 'prompts/**'];
    expect(matchesUserEditable('config/defaults.json', patterns)).toBe(true);
    expect(matchesUserEditable('config/defaults.json.bak', patterns)).toBe(false);
    expect(matchesUserEditable('prompts/a.md', patterns)).toBe(true);
    expect(matchesUserEditable('prompts/deep/a.md', patterns)).toBe(true);
    expect(matchesUserEditable('promptsx/a.md', patterns)).toBe(false);
    expect(matchesUserEditable('prompts', patterns)).toBe(false);
    expect(matchesUserEditable('anything', [])).toBe(false);
  });
});

describe('manifest userEditable', () => {
  // Purpose: the field is optional (absent means none) and round-trips when declared.
  it('is absent when undeclared and keeps a declared list', () => {
    const base = { name: 'p', version: '1.0.0', description: 'd', type: 'plugin' as const };
    expect(MarketplacePackageManifestSchema.parse(base).userEditable).toBeUndefined();
    expect(
      MarketplacePackageManifestSchema.parse({ ...base, userEditable: ['config/x.json'] })
        .userEditable
    ).toEqual(['config/x.json']);
  });

  // Purpose (code review 2): a case variant of an identity or reserved path
  // is that path on a case-insensitive volume, so it can't be user-editable.
  it.each(['.dork/Manifest.json', '.claude-plugin/Plugin.json', '.DORK/**', '.dork/Secrets.json'])(
    'refuses the case variant %s',
    (value) => {
      expect(UserEditablePathSchema.safeParse(value).success).toBe(false);
    }
  );

  // Purpose (delta review 2): a person approves the NEW version's copy of every
  // file that decides what a package runs, so none of them may be user-editable
  // (an edited copy would survive the update and run unapproved).
  it.each([
    'hooks/hooks.json',
    'hooks/**',
    'hooks/run.sh',
    'Hooks/hooks.json',
    '.mcp.json',
    '.lsp.json',
    '.dork/extensions/**',
    '.dork/extensions/x/index.ts',
    'monitors/**',
    'monitors/monitors.json',
    'bin/**',
    'bin/tool',
    '.dork/tasks/**',
    'skills/**',
    'skills/a/SKILL.md',
    'commands/**',
    'SKILL.md',
    'package.json',
    'agents/**',
    'agents/reviewer.md',
    'output-styles/**',
    'output-styles/terse.md',
    // What a harness loads from an agent's working directory (DOR-2314).
    '.claude/**',
    '.claude/settings.json',
    '.Claude/Settings.json',
    '.claude/agents/reviewer.md',
    '.agents/**',
    '.agents/skills/a/SKILL.md',
    '.codex/**',
    '.codex/config.toml',
    '.opencode/**',
    'opencode.json',
    'OpenCode.jsonc',
    '.gemini/**',
    '.gemini/settings.json',
  ])('refuses the effect-bearing path %s', (value) => {
    expect(UserEditablePathSchema.safeParse(value).success).toBe(false);
  });

  // Purpose: near-miss names beside an effect-bearing path stay editable.
  it.each([
    'config/**',
    'binder/x.json',
    'skillset/**',
    'hooks.md',
    'commands.md',
    'agents.md',
    '.claude-notes/x.md',
    'opencode.md',
  ])('still accepts %s', (value) => {
    expect(UserEditablePathSchema.safeParse(value).success).toBe(true);
  });

  // Purpose: a bad pattern makes the manifest invalid, not silently dropped.
  it('rejects a manifest whose userEditable names an identity file', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      name: 'p',
      version: '1.0.0',
      description: 'd',
      type: 'agent',
      userEditable: ['.dork/manifest.json'],
    });
    expect(result.success).toBe(false);
  });
});

describe('validUserEditable (DOR-2197 review 2)', () => {
  // Purpose: an old manifest (installed before the rules existed) can carry
  // entries the schema now refuses; a record rebuild must never trust them.
  it('keeps only entries the schema accepts', () => {
    expect(
      validUserEditable([
        'config/defaults.json',
        'skills/**',
        '**',
        '.dork/secrets.json',
        7,
        'prompts/**',
      ])
    ).toEqual(['config/defaults.json', 'prompts/**']);
  });
});

describe('declaredEffectPaths (DOR-2197 review 9)', () => {
  // Purpose: plugin.json can move hooks, servers, skills, commands, agents and
  // output styles anywhere; every such location is named, normalized, and one
  // that leaves the package is dropped.
  it('names every location plugin.json declares, inside the package only', () => {
    expect(
      declaredEffectPaths({
        hooks: './custom/hooks.json',
        mcpServers: { inline: true },
        commands: ['./cmds/', 'extra\\more'],
        skills: '../outside',
        agents: '/abs',
        experimental: { monitors: './watch/m.json' },
        outputStyles: 'styles/./x',
      }).sort()
    ).toEqual(['cmds', 'custom/hooks.json', 'extra/more', 'styles/x', 'watch/m.json']);
    expect(declaredEffectPaths(null)).toEqual([]);
  });
});
