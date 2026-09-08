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

  it('counts skills in both authored roots, follows a linked-in source, and skips DorkOS projections', () => {
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

  it('counts authored commands by their namespaced name and skips generated wrappers', () => {
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

  it('counts subagents recursively, so a nested definition is not lost (XA-01)', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inv-agents-'));
    for (const rel of ['reviewer', 'react/tanstack', 'deep/nested/helper']) {
      writeFileAt(join(repo, '.claude/agents', `${rel}.md`), `---\nname: x\n---\n\n# ${rel}\n`);
    }
    // Not a definition: the walk takes `.md` only.
    writeFileAt(join(repo, '.claude/agents/README.txt'), 'notes\n');

    const { agents } = inventorySourceTree(repo);
    expect(agents.length).toBe(3);
    expect(agents.map((a) => a.name)).toEqual(['deep/nested/helper', 'react/tanstack', 'reviewer']);
  });

  it('reads each rule’s `paths:` globs, in both spellings, and leaves a rule without them bare (IN-07)', () => {
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

  it('records MCP server names and never a value, because an env block holds secrets (XA-03)', () => {
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

  it('reads hooks from both settings files and from skill frontmatter, skipping DorkOS’s own groups (HK-12, HK-14)', () => {
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
