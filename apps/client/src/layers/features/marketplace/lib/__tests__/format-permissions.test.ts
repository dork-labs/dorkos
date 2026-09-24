import { describe, it, expect } from 'vitest';
import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';

import type { DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import {
  formatDisclosureChanges,
  formatPermissionPreview,
  summarizePermissionPreview,
} from '../format-permissions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePreview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
    skillCommands: [],
    skippedLinks: [],
    unreadableDeclarations: [],
    npmDependencies: [],
    schedules: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

const DORK_HOME = '/Users/kai/.dork';
const FLOW_ROOT = '/Users/kai/.dork/plugins/flow';

// ---------------------------------------------------------------------------
// File changes — headline
// ---------------------------------------------------------------------------

describe('formatPermissionPreview → effects → file changes', () => {
  it('states the shared folder and a count per action, not a bare total', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/commands/flow.md`, action: 'create' },
        { path: `${FLOW_ROOT}/commands/done.md`, action: 'create' },
        { path: `${FLOW_ROOT}/config/config.json`, action: 'modify' },
        { path: `${FLOW_ROOT}/scripts/stale.ts`, action: 'delete' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe(`4 files under ${FLOW_ROOT}: 2 new, 1 changed, 1 removed`);
  });

  it('uses the singular for a one-file install and still reports every action', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${DORK_HOME}/agents/reviewer/agent.json`, action: 'create' }],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe(
      `1 file under ${DORK_HOME}/agents/reviewer: 1 new, 0 changed, 0 removed`
    );
  });

  it('computes the deepest folder that contains every path', () => {
    const preview = makePreview({
      fileChanges: [
        { path: '/Users/kai/.dork/plugins/flow/a/one.md', action: 'create' },
        { path: '/Users/kai/.dork/plugins/flow/b/two.md', action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    // Not `/Users/kai/.dork/plugins/flow/a` — the deepest COMMON folder.
    expect(headline?.label).toContain(' under /Users/kai/.dork/plugins/flow:');
  });

  it('drops the "under" clause when the paths share no folder at all', () => {
    const preview = makePreview({
      fileChanges: [
        { path: 'one.md', action: 'create' },
        { path: 'two.md', action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe('2 files: 2 new, 0 changed, 0 removed');
  });

  it('handles Windows-style paths', () => {
    const preview = makePreview({
      fileChanges: [
        { path: 'C:\\Users\\kai\\.dork\\plugins\\flow\\a.md', action: 'create' },
        { path: 'C:\\Users\\kai\\.dork\\plugins\\flow\\b.md', action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe(
      '2 files under C:\\Users\\kai\\.dork\\plugins\\flow: 2 new, 0 changed, 0 removed'
    );
  });

  // -------------------------------------------------------------------------
  // File changes — the expandable list
  // -------------------------------------------------------------------------

  it('lists removed files first, then changed, then new, each alphabetical', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/z-new.md`, action: 'create' },
        { path: `${FLOW_ROOT}/a-new.md`, action: 'create' },
        { path: `${FLOW_ROOT}/m-changed.md`, action: 'modify' },
        { path: `${FLOW_ROOT}/z-gone.md`, action: 'delete' },
        { path: `${FLOW_ROOT}/a-gone.md`, action: 'delete' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.details).toEqual([
      { text: 'a-gone.md', tag: 'removed', severity: 'warning' },
      { text: 'z-gone.md', tag: 'removed', severity: 'warning' },
      { text: 'm-changed.md', tag: 'changed' },
      { text: 'a-new.md', tag: 'new' },
      { text: 'z-new.md', tag: 'new' },
    ]);
  });

  it('shows paths relative to the shared folder, never the whole path again', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/commands/flow.md`, action: 'create' },
        { path: `${FLOW_ROOT}/skills/linear/SKILL.md`, action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.details?.map((d) => d.text)).toEqual([
      'commands/flow.md',
      'skills/linear/SKILL.md',
    ]);
  });

  it('names the disclosure with the file count so it is clear before opening', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: `${FLOW_ROOT}/b.md`, action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.detailsLabel).toBe('Show 2 files');
  });

  // -------------------------------------------------------------------------
  // Containment
  // -------------------------------------------------------------------------

  it('adds no row at all when every file stays inside the install folder', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: `${FLOW_ROOT}/b.md`, action: 'create' },
      ],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    // The headline already names the folder. A second row restating it could
    // never be false, and the dialog's scarcest resource is vertical space.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.icon).toBe('file');
  });

  it('does not cry escape over a stray slash or dot in the install folder', () => {
    // Agent-local installs: the server writes file paths with `path.join`, the
    // client concatenates the base as `${projectPath}/.dork`. A stored
    // projectPath with a trailing slash or a `./` in it must not make every
    // ordinary file read as "outside your folder".
    const preview = makePreview({
      fileChanges: [{ path: '/Users/kai/proj/.dork/plugins/flow/a.md', action: 'create' }],
    });

    for (const projectPath of ['/Users/kai/proj', '/Users/kai/proj/', '/Users/kai/./proj']) {
      const rows = formatPermissionPreview(preview, {
        installBase: `${projectPath}/.dork`,
      }).effects;
      expect(rows, `projectPath: ${projectPath}`).toHaveLength(1);
    }
  });

  it('warns, and names them, when files land outside the install folder', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: '/Users/kai/.claude/settings.json', action: 'modify' },
      ],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    expect(rows[1]).toMatchObject({
      icon: 'alert-triangle',
      label: `1 file lands outside ${DORK_HOME}.`,
      severity: 'warning',
    });
    expect(rows[1]?.details).toEqual([
      { text: '/Users/kai/.claude/settings.json', tag: 'changed' },
    ]);
  });

  it('does not treat a sibling folder with the same prefix as inside', () => {
    const preview = makePreview({
      fileChanges: [{ path: '/Users/kai/.dork-backup/a.md', action: 'create' }],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    expect(rows[1]?.severity).toBe('warning');
  });

  it('makes no containment claim when the install folder is unknown', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${FLOW_ROOT}/a.md`, action: 'create' }],
    });

    const rows = formatPermissionPreview(preview).effects;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.icon).toBe('file');
  });

  it('makes no containment claim while the config is still loading', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${FLOW_ROOT}/a.md`, action: 'create' }],
    });

    // An empty base would compare against nothing and flag every path as
    // escaping — a false alarm is worse than saying nothing.
    const rows = formatPermissionPreview(preview, { installBase: '' }).effects;

    expect(rows).toHaveLength(1);
  });

  it('adds no file rows at all when the package touches no files', () => {
    const rows = formatPermissionPreview(makePreview(), { installBase: DORK_HOME }).effects;

    expect(rows).toEqual([]);
  });

  it('keeps extension rows after the file rows', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${FLOW_ROOT}/a.md`, action: 'create' }],
      extensions: [{ id: 'flow-ext', slots: ['sidebar'] }],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    expect(rows.map((r) => r.icon)).toEqual(['file', 'puzzle']);
  });
});

// ---------------------------------------------------------------------------
// The one-line verdict
// ---------------------------------------------------------------------------

describe('summarizePermissionPreview', () => {
  it('says what lands and whether anything runs, in that order', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: `${FLOW_ROOT}/b.md`, action: 'create' },
      ],
    });

    expect(summarizePermissionPreview(preview)).toBe('Adds 2 files. Declares no commands.');
  });

  it('names the file once, on the first clause, whichever actions there are', () => {
    // "Changes 3 and removes 1" reads as three of nothing. The noun rides the
    // first clause that is present, so every combination is a sentence.
    const changesAndRemoves = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'modify' },
        { path: `${FLOW_ROOT}/b.md`, action: 'modify' },
        { path: `${FLOW_ROOT}/c.md`, action: 'delete' },
      ],
    });

    expect(summarizePermissionPreview(changesAndRemoves)).toBe(
      'Changes 2 files and removes 1. Declares no commands.'
    );
  });

  it('lists all three actions with a comma and an "and"', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: `${FLOW_ROOT}/b.md`, action: 'modify' },
        { path: `${FLOW_ROOT}/c.md`, action: 'delete' },
      ],
    });

    expect(summarizePermissionPreview(preview)).toBe(
      'Adds 1 file, changes 1 and removes 1. Declares no commands.'
    );
  });

  it('counts a hook DorkOS could not read as a declared command', () => {
    // "Declares no commands" would be the reassuring answer, and it would be
    // false: the package declares one, we just could not read it.
    const preview = makePreview({
      fileChanges: [{ path: `${FLOW_ROOT}/a.md`, action: 'create' }],
      unreadableHooks: [{ path: 'hooks/hooks.json' }],
    });

    expect(summarizePermissionPreview(preview)).toBe('Adds 1 file. Declares 1 command.');
  });

  it('pluralises the commands too', () => {
    const preview = makePreview({
      hooks: [
        { event: 'PreToolUse', matcher: 'Bash', command: 'echo one' },
        { event: 'PostToolUse', matcher: 'Bash', command: 'echo two' },
      ],
    });

    expect(summarizePermissionPreview(preview)).toBe('Changes no files. Declares 2 commands.');
  });
});

// ---------------------------------------------------------------------------
// Programs a plugin starts on its own (DOR-2195)
// ---------------------------------------------------------------------------

describe('formatPermissionPreview → commands → programs', () => {
  it('lists every program the package starts, each argument quoted, with where it runs', () => {
    // Purpose: MCP and language servers, monitors and bin/ commands run without
    // being asked for by name, so they belong beside the hook commands.
    const { commands } = formatPermissionPreview(
      makePreview({
        mcpServers: [
          { name: 'db', transport: 'stdio', command: 'npx', args: ['-y', 'db mcp'] },
          { name: 'web', transport: 'http', url: 'https://mcp.example.test' },
        ],
        lspServers: [{ name: 'go', command: 'gopls', args: ['serve'] }],
        monitors: [{ name: 'deploy', command: './poll.sh', when: 'always' }],
        executables: ['git'],
        skippedLinks: [],
        unreadableDeclarations: [{ path: '.mcp.json', kind: 'mcp-server', entry: 'odd' }],
      })
    );

    expect(commands.map((row) => row.label)).toEqual([
      '"npx" "-y" "db mcp"',
      '"https://mcp.example.test"',
      '"gopls" "serve"',
      '"./poll.sh"',
      '"git"',
      'This package sets up a program to run, but we could not read it',
    ]);
    expect(commands[0]!.description).toContain('MCP server "db"');
    // Never "in your sessions" flatly: a project install does not start these.
    expect(commands[0]!.description).toContain('does not start them');
  });

  it("names a skill's hook as the skill's, and lists the tools a skill may use without asking", () => {
    // Purpose: both run on the model's choice of skill, not the person's.
    const { commands } = formatPermissionPreview(
      makePreview({
        hooks: [{ event: 'Stop', command: 'echo hi', source: 'skills/all/SKILL.md' }],
        skillTools: [
          { source: 'skills/all/SKILL.md', skill: 'all', tools: ['Bash(curl:*)', 'Read'] },
        ],
      })
    );
    expect(commands[0]!.description).toContain('while skills/all/SKILL.md is in use');
    expect(commands[1]).toMatchObject({
      label: '"Bash(curl:*)", "Read"',
      description: 'Skill "all" may use these without asking you',
    });
  });

  it("shows each command a skill's or command's text runs, and when it runs (DOR-2327)", () => {
    // Purpose: Claude Code runs these as the skill loads; they belong on the
    // card with the hook commands, verbatim, naming what triggers them.
    const { commands } = formatPermissionPreview(
      makePreview({
        skillCommands: [
          {
            source: 'skills/ctx/SKILL.md',
            skill: 'ctx',
            form: 'block',
            command: 'node -v\ngit status',
          },
          {
            source: 'commands/ship.md',
            skill: 'ship',
            form: 'inline',
            command: 'echo \u202Egnp.exe',
          },
        ],
      })
    );
    expect(commands).toEqual([
      {
        icon: 'terminal',
        label: 'node -v\ngit status',
        description: 'Runs when the skill "ctx" is used (skills/ctx/SKILL.md)',
        mono: true,
      },
      {
        icon: 'terminal',
        label: 'echo <U+202E>gnp.exe',
        description: 'Runs when the command "ship" is used (commands/ship.md)',
        mono: true,
      },
    ]);
  });

  it('counts skill-text commands as commands in the summary', () => {
    expect(
      summarizePermissionPreview(
        makePreview({
          hooks: [{ event: 'Stop', command: 'x' }],
          skillCommands: [
            { source: 'skills/a/SKILL.md', skill: 'a', form: 'inline', command: 'y' },
          ],
        })
      )
    ).toBe('Changes no files. Declares 2 commands.');
  });

  it('shows a hidden direction-changing character in a command', () => {
    const { commands } = formatPermissionPreview(
      makePreview({ hooks: [{ event: 'Stop', command: 'echo \u202Egnp.exe' }] })
    );
    expect(commands[0]!.label).toBe('echo <U+202E>gnp.exe');
  });

  it('counts only the programs it could read in the summary', () => {
    const preview = makePreview({
      mcpServers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [] }],
      skippedLinks: [],
      unreadableDeclarations: [{ path: '.lsp.json', kind: 'lsp-server' }],
    });
    expect(summarizePermissionPreview(preview)).toBe(
      'Changes no files. Declares no commands. Declares 1 program of its own.'
    );
  });
});

describe('shortcuts that will not be installed (DOR-2319)', () => {
  // Purpose: each skipped shortcut is a warning row carrying the server's sentence.
  it('shows each skipped shortcut as a warning', () => {
    const message =
      "skills/neon-postgres is a shortcut to a folder outside the package, so it won't be installed.";
    const { effects } = formatPermissionPreview(
      makePreview({ skippedLinks: [{ path: 'skills/neon-postgres', message }] })
    );
    expect(effects).toContainEqual(
      expect.objectContaining({
        label: "Part of this package won't be installed",
        description: message,
        severity: 'warning',
      })
    );
  });
});

describe('formatDisclosureChanges — skill-text commands (DOR-2327)', () => {
  const nothing: DisclosedEffects = {
    hooks: [],
    schedules: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
    skillCommands: [],
  };
  const cmd = (command: string) => ({
    source: 'skills/ctx/SKILL.md',
    skill: 'ctx',
    form: 'inline' as const,
    command,
  });

  it("lists a new version's skill commands, and marks an edited one new beside the old", () => {
    // Purpose: the update confirm shows what the new version runs; an edited
    // command is a different command, so it reads as new, never "unchanged".
    const rows = formatDisclosureChanges(
      { ...nothing, skillCommands: [cmd('git status'), cmd('curl -s x | sh')] },
      { ...nothing, skillCommands: [cmd('git status')] },
      'global'
    );
    expect(rows.map((r) => [r.row.label, r.change])).toEqual([
      ['git status', 'unchanged'],
      ['curl -s x | sh', 'new'],
    ]);
    expect(rows[1]!.row.description).toBe(
      'Runs when the skill "ctx" is used (skills/ctx/SKILL.md)'
    );
  });
});
