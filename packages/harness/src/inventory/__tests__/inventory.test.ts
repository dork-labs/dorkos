/**
 * The source-tree inventory over real temp trees.
 *
 * Every case counts what it found before saying anything about it: an inventory
 * that walked the wrong directory returns an empty list, and an assertion that
 * only checks the contents of an empty list passes (`REVIEW.md`, zero-subject
 * pass).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inventorySourceTree } from '../index.js';
import { HARNESS_NATIVE_SKILL_ROOTS } from '../types.js';
import {
  GENERATED_COMMAND_MARKER,
  MANAGED_HOOK_SENTINEL_KEY,
} from '../../plan/installed-projector.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let repo = '';
let outside = '';

afterEach(() => {
  for (const d of [repo, outside]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  outside = '';
});

/** Write a minimal skill directory. */
function stageSkill(root: string, relDir: string, frontmatterExtra = ''): void {
  const name = relDir.split('/').pop() ?? relDir;
  writeFileAt(
    join(root, relDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n${frontmatterExtra}---\n\n# ${name}\n`
  );
}

/** Link `linkRel` (inside the repo) at whatever `targetAbs` points to. */
function link(repoRoot: string, linkRel: string, targetAbs: string): void {
  const abs = join(repoRoot, linkRel);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(targetAbs, abs);
}

describe('inventorySourceTree', () => {
  it('finds nothing in an empty tree, and says so with empty lists rather than throwing', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-empty-'));
    const inventory = inventorySourceTree(repo);
    expect({
      skills: inventory.skills.length,
      commands: inventory.commands.length,
      hooks: inventory.hooks.length,
      agents: inventory.agents.length,
      rules: inventory.rules.length,
      mcpServers: inventory.mcpServers.length,
      unreadable: inventory.unreadable.length,
    }).toEqual({
      skills: 0,
      commands: 0,
      hooks: 0,
      agents: 0,
      rules: 0,
      mcpServers: 0,
      unreadable: 0,
    });
  });

  it('SK-13: counts skills in both authored roots, follows a linked-in source, and skips DorkOS projections', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-skills-'));
    outside = mkdtempSync(join(tmpdir(), 'harness-inv-outside-'));

    stageSkill(repo, '.agents/skills/alpha');
    // A real directory whose name carries `__`: authored, and counted (DOR-1844).
    stageSkill(repo, '.agents/skills/my__helper');
    // A skill kept outside the repository and linked in.
    stageSkill(outside, 'vendored', '');
    link(repo, '.agents/skills/vendored', join(outside, 'vendored'));
    // DorkOS's own installed projection: `__` AND a symlink. Not a source.
    stageSkill(repo, '.dork/plugins/flow/skills/capture');
    link(repo, '.agents/skills/flow__capture', join(repo, '.dork/plugins/flow/skills/capture'));
    // A real skill only Claude Code reads, and DorkOS's own link beside it.
    stageSkill(repo, '.claude/skills/claude-only');
    link(repo, '.claude/skills/alpha', join(repo, '.agents/skills/alpha'));

    const { skills } = inventorySourceTree(repo);
    expect(skills.length).toBe(4);
    expect(skills.map((s) => `${s.root}:${s.name}:${s.isSymlink}`).sort()).toEqual([
      '.agents/skills:alpha:false',
      '.agents/skills:my__helper:false',
      '.agents/skills:vendored:true',
      '.claude/skills:claude-only:false',
    ]);
  });

  it('inventories a person’s own link into .claude/skills, and still skips DorkOS’s', () => {
    // Not every symlink in `.claude/skills` is a projection. A person who keeps a
    // skill elsewhere in the repo and links it where Claude Code reads had it
    // treated as DorkOS's own output and given no line at all — while the
    // projector next door already knew the other shape ("a link to a skill kept
    // elsewhere", `planClaudeOnlySkills`). The target decides, not the fact of
    // being a link: into `.agents/skills` or `.dork/plugins` is ours, anywhere
    // else is theirs.
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-person-link-'));

    stageSkill(repo, 'vendor/skills/mine');
    link(repo, '.claude/skills/mine', join(repo, 'vendor/skills/mine'));
    stageSkill(repo, '.agents/skills/alpha');
    link(repo, '.claude/skills/alpha', join(repo, '.agents/skills/alpha'));
    stageSkill(repo, '.dork/plugins/flow/skills/capture');
    link(repo, '.claude/skills/flow__capture', join(repo, '.dork/plugins/flow/skills/capture'));

    const { skills } = inventorySourceTree(repo);
    expect(skills.length).toBe(2);
    expect(skills.map((s) => `${s.root}:${s.name}:${s.isSymlink}`)).toEqual([
      '.agents/skills:alpha:false',
      '.claude/skills:mine:true',
    ]);
  });

  it('CM-04: counts authored commands by their namespaced name and skips generated wrappers', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-commands-'));
    writeFileAt(join(repo, '.claude/commands/deploy.md'), '# /deploy\n');
    writeFileAt(join(repo, '.claude/commands/flow/capture.md'), '# /flow:capture\n');
    writeFileAt(
      join(repo, '.claude/commands/acme/ship.md'),
      `<!-- ${GENERATED_COMMAND_MARKER} from .dork/plugins/acme -->\n# ship\n`
    );

    const { commands } = inventorySourceTree(repo);
    expect(commands.length).toBe(2);
    expect(commands.map((c) => c.name)).toEqual(['deploy', 'flow/capture']);
    expect(commands.map((c) => c.source)).toEqual([
      '.claude/commands/deploy.md',
      '.claude/commands/flow/capture.md',
    ]);
  });

  it('XA-01: counts subagents recursively, so a nested definition is not lost', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-agents-'));
    for (const rel of ['reviewer', 'react/tanstack', 'deep/nested/helper']) {
      const name = rel.split('/').join('-');
      writeFileAt(
        join(repo, '.claude/agents', `${rel}.md`),
        `---\nname: ${name}\ndescription: The ${name} subagent\n---\n\n# ${rel}\n`
      );
    }
    // Not a definition: the walk takes `.md` only.
    writeFileAt(join(repo, '.claude/agents/README.txt'), 'notes\n');

    const { agents } = inventorySourceTree(repo);
    expect(agents.length).toBe(3);
    expect(agents.map((a) => [a.name, a.source])).toEqual([
      ['deep-nested-helper', '.claude/agents/deep/nested/helper.md'],
      ['react-tanstack', '.claude/agents/react/tanstack.md'],
      ['reviewer', '.claude/agents/reviewer.md'],
    ]);
  });

  it('IN-07: reads each rule’s `paths:` globs, in both spellings, and leaves a rule without them bare', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-rules-'));
    writeFileAt(
      join(repo, '.claude/rules/api.md'),
      '---\npaths: apps/server/**/*.ts, packages/*/src/**/*.ts\n---\n\n# api\n'
    );
    writeFileAt(
      join(repo, '.claude/rules/ui.md'),
      '---\npaths:\n  - apps/client/**/*.tsx\n---\n\n# ui\n'
    );
    writeFileAt(join(repo, '.claude/rules/style.md'), '# style\n');

    const { rules } = inventorySourceTree(repo);
    expect(rules.length).toBe(3);
    expect(rules.map((r) => [r.name, r.paths])).toEqual([
      ['api', ['apps/server/**/*.ts', 'packages/*/src/**/*.ts']],
      ['style', undefined],
      ['ui', ['apps/client/**/*.tsx']],
    ]);
  });

  it('finds a rule in a subdirectory, because Claude Code discovers .claude/rules recursively', () => {
    // "All `.md` files are discovered recursively, so you can organize rules into
    // subdirectories like `frontend/`" — https://code.claude.com/docs/en/memory,
    // fetched 2026-09-08. A flat walk gave a nested rule ZERO lines under every
    // harness, which is the exact silence this whole module exists to end.
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-nested-rules-'));
    writeFileAt(join(repo, '.claude/rules/api.md'), '---\npaths: src/**/*.ts\n---\n\n# api\n');
    writeFileAt(
      join(repo, '.claude/rules/frontend/nested-style.md'),
      '---\npaths: apps/client/**/*.tsx\n---\n\n# nested style\n'
    );

    const { rules } = inventorySourceTree(repo);
    expect(rules.length).toBe(2);
    expect(rules.map((r) => [r.name, r.source])).toEqual([
      ['api', '.claude/rules/api.md'],
      ['frontend/nested-style', '.claude/rules/frontend/nested-style.md'],
    ]);
  });

  it('descends into a linked-in directory of rules or subagents, and terminates on a loop', () => {
    // A person keeps their company's shared rules and subagents outside the repo
    // and links the folder in. `Dirent.isDirectory()` is false for a symlink — the
    // same trap `scan/scanner.ts` documents for skills — so the walk saw an entry
    // that was neither a directory nor an `.md` file and skipped it in silence.
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-linked-dirs-'));
    outside = mkdtempSync(join(tmpdir(), 'harness-inv-company-'));

    writeFileAt(
      join(outside, 'rules', 'security.md'),
      "---\npaths: '**/*.ts'\n---\n\n# security\n"
    );
    writeFileAt(
      join(outside, 'agents', 'auditor.md'),
      '---\nname: auditor\ndescription: Audits\n---\n\n# auditor\n'
    );
    mkdirSync(join(repo, '.claude', 'rules'), { recursive: true });
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
    symlinkSync(join(outside, 'rules'), join(repo, '.claude/rules/shared'));
    symlinkSync(join(outside, 'agents'), join(repo, '.claude/agents/shared'));
    // A link back at its own parent: the walk must stop, not recurse forever.
    symlinkSync(join(repo, '.claude', 'rules'), join(repo, '.claude/rules/loop'));

    const inventory = inventorySourceTree(repo);
    expect(inventory.rules.map((r) => r.source)).toEqual(['.claude/rules/shared/security.md']);
    expect(inventory.agents.map((a) => a.source)).toEqual(['.claude/agents/shared/auditor.md']);
    expect(inventory.unreadable).toEqual([]);
  });

  it('keys a subagent by its frontmatter name, which is the only identity Claude Code uses', () => {
    // "The subdirectory path doesn't affect how a subagent is identified or
    // invoked, because identity comes only from the `name` frontmatter field" —
    // https://code.claude.com/docs/en/sub-agents, fetched 2026-09-08. The report
    // named a nested subagent `react/tanstack`, which is not a name anybody can
    // type at it.
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-agent-names-'));
    writeFileAt(
      join(repo, '.claude/agents/react/tanstack.md'),
      '---\nname: react-tanstack-expert\ndescription: React\n---\n\n# expert\n'
    );
    writeFileAt(join(repo, '.claude/agents/nameless.md'), '# no frontmatter at all\n');

    const { agents, unreadable } = inventorySourceTree(repo);
    expect(agents.length).toBe(2);
    expect(agents.map((a) => [a.name, a.source])).toEqual([
      ['nameless', '.claude/agents/nameless.md'],
      ['react-tanstack-expert', '.claude/agents/react/tanstack.md'],
    ]);
    // The one with no declared name is still a file Claude Code reads, so it is
    // inventoried under its stem — and reported, because its identity is a guess.
    expect(unreadable.map((u) => u.source)).toEqual(['.claude/agents/nameless.md']);
  });

  it.each(HARNESS_NATIVE_SKILL_ROOTS)(
    'XA-06: counts a skill in %s, the folder another agent tool reads',
    (root) => {
      repo = mkdtempSync(join(tmpdir(), 'harness-inv-native-'));
      stageSkill(repo, `${root}/review-pr`);

      const { skills, unreadable } = inventorySourceTree(repo);
      expect(skills).toEqual([
        {
          kind: 'skill',
          name: 'review-pr',
          source: `${root}/review-pr`,
          provenance: 'authored',
          isSymlink: false,
          root,
          frontmatterName: 'review-pr',
        },
      ]);
      expect(unreadable).toEqual([]);
    }
  );

  it('XA-06: walks no skills folder the vendor table does not document', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-unknown-root-'));
    // One root the table DOES document, so the assertion below is about the
    // other two rather than about a walk that found nothing at all.
    stageSkill(repo, '.opencode/skills/review-pr');
    stageSkill(repo, '.zed/skills/review-pr');
    stageSkill(repo, '.windsurf/skills/review-pr');

    const { skills } = inventorySourceTree(repo);
    expect(skills.map((skill) => skill.source)).toEqual(['.opencode/skills/review-pr']);
  });

  it('XA-06: says nothing about a harness-native root that is not there, and names one it cannot list', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-native-broken-'));
    // Absent: `.cursor/skills` and the rest of them. Present and unusable: a
    // FILE where `.opencode/skills` belongs, which is what a person gets for
    // typing `> .opencode/skills` once.
    writeFileAt(join(repo, '.opencode', 'skills'), 'not a directory\n');
    stageSkill(repo, '.gemini/skills/ship');

    const { skills, unreadable } = inventorySourceTree(repo);
    expect(skills.map((skill) => skill.source)).toEqual(['.gemini/skills/ship']);
    expect(unreadable.map((entry) => ({ kind: entry.kind, source: entry.source }))).toEqual([
      { kind: 'skill', source: '.opencode/skills' },
    ]);
    expect(unreadable[0]?.reason).toContain('.opencode/skills could not be listed as a directory');
  });

  it('XA-07: counts the servers in another tool’s MCP config and records no name and no value', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-foreign-mcp-'));
    writeJsonAt(join(repo, 'opencode.json'), {
      $schema: 'https://opencode.ai/config.json',
      theme: 'system',
      mcp: {
        linear: { type: 'local', command: ['npx', 'linear-mcp'] },
        resend: {
          type: 'local',
          command: ['npx', 'resend-mcp'],
          environment: { RESEND_API_KEY: 're_TOPSECRET' },
        },
      },
    });
    writeJsonAt(join(repo, '.cursor', 'mcp.json'), {
      mcpServers: { shadcn: { command: 'npx', env: { CURSOR_TOKEN: 'ct_TOPSECRET' } } },
    });
    // A server split over a table and a sub-table is ONE server: taking the name
    // up to its first dot is what makes `[mcp_servers.linear.env]` not a second.
    writeFileAt(
      join(repo, '.codex', 'config.toml'),
      '[mcp_servers.linear]\ncommand = "npx"\n\n[mcp_servers.linear.env]\nLINEAR_API_KEY = "lin_TOPSECRET"\n\n[mcp_servers.shadcn]\ncommand = "npx"\n'
    );

    const { foreignMcpConfigs, mcpServers, unreadable } = inventorySourceTree(repo);
    expect(foreignMcpConfigs).toEqual([
      { source: '.codex/config.toml', serverCount: 2 },
      { source: '.cursor/mcp.json', serverCount: 1 },
      { source: 'opencode.json', serverCount: 2 },
    ]);
    // Not `.mcp.json`, which this tree does not have — a foreign config is never
    // mistaken for the one file the engine reads.
    expect(mcpServers).toEqual([]);
    expect(unreadable).toEqual([]);
    // Not one name and not one value reaches the record. The keys are as
    // sensitive as the values here: `RESEND_API_KEY` names what the file holds.
    const recorded = JSON.stringify(foreignMcpConfigs);
    for (const secret of ['TOPSECRET', 'RESEND_API_KEY', 'LINEAR_API_KEY', 'linear', 'shadcn']) {
      expect(recorded).not.toContain(secret);
    }
  });

  it('XA-07: stays silent about another tool’s config that declares no MCP servers at all', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-foreign-quiet-'));
    writeJsonAt(join(repo, 'opencode.json'), { $schema: 'x', theme: 'system' });
    writeFileAt(join(repo, '.codex', 'config.toml'), 'model = "gpt-5"\n');

    const { foreignMcpConfigs, unreadable } = inventorySourceTree(repo);
    expect({ foreignMcpConfigs, unreadable }).toEqual({ foreignMcpConfigs: [], unreadable: [] });
  });

  it('XA-07: reports another tool’s MCP config that will not parse, and quotes none of it', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-foreign-broken-'));
    // An UNQUOTED value, deliberately: that is the failure shape whose V8 message
    // quotes the surrounding text back — `Unexpected token 'r', ..." { "key":
    // re_TOPSECR"... is not valid JSON` — so the "quotes none of it" assertion
    // below has something real to catch.
    writeFileAt(join(repo, 'opencode.json'), '{ "mcp": { "resend": { "key": re_TOPSECRET } } }');
    writeJsonAt(join(repo, '.cursor', 'mcp.json'), { mcpServers: ['not', 'an', 'object'] });

    const { foreignMcpConfigs, unreadable } = inventorySourceTree(repo);
    expect(foreignMcpConfigs).toEqual([]);
    expect(unreadable).toEqual([
      {
        kind: 'mcp',
        source: '.cursor/mcp.json',
        reason:
          '.cursor/mcp.json has a "mcpServers" key that is not an object, so DorkOS could not count the MCP servers in it — Cursor keeps MCP servers here (vendor docs, 2026-09-07)',
      },
      {
        kind: 'mcp',
        source: 'opencode.json',
        reason:
          'opencode.json is not valid JSON, so DorkOS could not read what it declares — OpenCode keeps MCP servers here, under "mcp" (vendor docs, 2026-09-07)',
      },
    ]);
    expect(JSON.stringify(unreadable)).not.toContain('TOPSECRET');
  });

  it('XA-03: records MCP server names and never a value, because an env block holds secrets', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-mcp-'));
    writeJsonAt(join(repo, '.mcp.json'), {
      mcpServers: {
        resend: { command: 'npx', args: ['resend-mcp'], env: { RESEND_API_KEY: 're_TOPSECRET' } },
        shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] },
      },
    });

    const { mcpServers } = inventorySourceTree(repo);
    expect(mcpServers.length).toBe(2);
    expect(mcpServers.map((s) => s.name)).toEqual(['resend', 'shadcn']);
    expect(JSON.stringify(mcpServers)).not.toContain('TOPSECRET');
    expect(JSON.stringify(mcpServers)).not.toContain('RESEND_API_KEY');
  });

  it('HK-12, HK-14: reads hooks from both settings files and from skill frontmatter, skipping DorkOS’s own groups', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-hooks-'));
    writeJsonAt(join(repo, '.claude/settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo authored' }] }] },
    });
    writeJsonAt(join(repo, '.claude/settings.local.json'), {
      hooks: {
        // A person's own group: theirs, and reported.
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
        // Entirely DorkOS's: merged in from an installed plugin, not a source.
        SessionStart: [
          {
            [MANAGED_HOOK_SENTINEL_KEY]: 'flow',
            hooks: [{ type: 'command', command: 'echo dork' }],
          },
        ],
        // Mixed: a person's hook that happens to share an event with a plugin's.
        PostToolUse: [
          {
            [MANAGED_HOOK_SENTINEL_KEY]: 'flow',
            hooks: [{ type: 'command', command: 'echo dork' }],
          },
          { hooks: [{ type: 'command', command: 'echo also mine' }] },
        ],
      },
    });
    stageSkill(
      repo,
      '.agents/skills/guarded',
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./guard.sh\n'
    );
    stageSkill(repo, '.agents/skills/plain');

    const { hooks } = inventorySourceTree(repo);
    expect(hooks.length).toBe(4);
    expect(hooks.map((h) => `${h.origin}:${h.event}`)).toEqual([
      'claude-settings:Stop',
      'claude-settings-local:PostToolUse',
      'claude-settings-local:PreToolUse',
      'skill-frontmatter:PreToolUse',
    ]);
    expect(hooks.at(-1)).toMatchObject({
      name: 'guarded:PreToolUse',
      skill: 'guarded',
      source: '.agents/skills/guarded/SKILL.md',
    });
  });
});
