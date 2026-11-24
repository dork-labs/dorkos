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
import { MANAGED_HOOK_SENTINEL_KEY } from '../../plan/installed-projector.js';
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

  it('XA-07: reports another tool’s MCP config that will not parse, and quotes none of it', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-foreign-broken-'));
    // An UNQUOTED value, deliberately: that is the failure shape whose V8 message
    // quotes the surrounding text back — `Unexpected token 'r', ..." { "key":
    // re_TOPSECR"... is not valid JSON` — so the "quotes none of it" assertion
    // below has something real to catch.
    writeFileAt(join(repo, 'opencode.json'), '{ "mcp": { "resend": { "key": re_TOPSECRET } } }');
    writeJsonAt(join(repo, '.cursor', 'mcp.json'), { mcpServers: ['not', 'an', 'object'] });
    // Valid TOML whose `mcp_servers` is a string. Each format is told it is
    // wrong in its OWN vocabulary — TOML has tables, JSON has objects — because a
    // person reading a line about their `.codex/config.toml` should not be told
    // it holds the wrong kind of object.
    writeFileAt(join(repo, '.codex', 'config.toml'), 'mcp_servers = "nope"\n');

    const { foreignMcpConfigs, unreadable } = inventorySourceTree(repo);
    expect(foreignMcpConfigs).toEqual([]);
    expect(unreadable).toEqual([
      {
        kind: 'mcp',
        source: '.codex/config.toml',
        reason:
          '.codex/config.toml has an mcp_servers key that is not a table, so DorkOS could not count the MCP servers in it — Codex keeps MCP servers here, under [mcp_servers.<name>] (vendor docs, 2026-09-07)',
      },
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
