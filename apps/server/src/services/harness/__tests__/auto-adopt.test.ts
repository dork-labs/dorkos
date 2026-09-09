/**
 * @vitest-environment node
 *
 * `harness.autoAdopt` end to end, against a real engine, a real seeder and a
 * real config store (DOR-1853; contract §16 D3, SRC-07, SK-16, AP-17).
 *
 * Nothing here is mocked but the logger, which is asserted rather than silenced:
 * the per-workspace line IS the boot surface, and a test that stubbed the engine
 * would prove nothing about which skills the allowlist lets through.
 *
 * The claim that matters most is the FIRST one: with the flag at its default,
 * every candidate is found and none of them is moved. Everything else in this
 * file is about what happens when somebody turns it on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { backfillAgentWorkspaceSkills } from '../project-agent-workspace.js';
import { adoptInOwnedWorkspace } from '../adopt-owned-workspace.js';
import { resolveDirectoryOwnership } from '../directory-ownership.js';
import { initConfigManager, configManager } from '../../core/config-manager.js';
import { logger } from '../../../lib/logger.js';
import { SEEDED_PACK_EXCLUDES } from '../../rooms/repo/room-worktree-manager.js';

let dorkHome: string;

/**
 * The three skills every agent-home case here starts from — one the allowlist
 * passes and two it does not, for two DIFFERENT reasons.
 *
 * `hooky` carries a `hooks:` block, which `SkillFrontmatterSchema` strips and
 * the allowlist therefore has to read raw; `contexty` carries `context:`, plain
 * Claude Code dialect. Two reasons rather than two of one, so a guard that
 * happened to catch only one of them cannot pass this file.
 */
const CANDIDATES: readonly { name: string; frontmatter: string }[] = [
  { name: 'safe', frontmatter: 'name: safe\ndescription: A portable skill\n' },
  {
    name: 'hooky',
    frontmatter: 'name: hooky\ndescription: Runs a command\nhooks:\n  PreToolUse:\n    - echo hi\n',
  },
  { name: 'contexty', frontmatter: 'name: contexty\ndescription: Forked\ncontext: fork\n' },
];

/** Write one skill directory with the frontmatter its author wrote. */
function writeSkill(root: string, name: string, frontmatter: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\n${frontmatter}---\n\nDo the thing.\n`);
}

/**
 * A workspace with the three candidates in Claude Code's own folder, an empty
 * canonical layer so the projection runs, and a manifest enabling Codex beside
 * Claude Code.
 *
 * Codex is enabled deliberately: `adoptableSentence` names the tools that cannot
 * see a skill and prints NOTHING when the list is empty, so a claude-code-only
 * manifest would make the headline assertions vacuous.
 */
function buildWorkspace(dir: string): string {
  mkdirSync(join(dir, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  writeFileSync(
    join(dir, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
  );
  for (const candidate of CANDIDATES) {
    writeSkill(join(dir, '.claude', 'skills'), candidate.name, candidate.frontmatter);
  }
  return dir;
}

/** An agent workspace inside the fake dork home, so `isAgentHome` accepts it. */
function buildAgentHome(name: string): string {
  const dir = join(dorkHome, 'agents', name);
  mkdirSync(dir, { recursive: true });
  return buildWorkspace(dir);
}

/**
 * The names of THESE THREE fixtures found under one root, sorted.
 *
 * Narrowed to the fixtures on purpose: `backfillAgentWorkspaceSkills` also seeds
 * the seven-skill Operating DorkOS pack into `.agents/skills` and links every
 * one of them into `.claude/skills`, and a bare listing would be an assertion
 * about the pack's size rather than about what this pass moved.
 */
function fixturesUnder(dir: string, ...segments: string[]): string[] {
  const root = join(dir, ...segments);
  if (!existsSync(root)) return [];
  const names = new Set(CANDIDATES.map((c) => c.name));
  return readdirSync(root)
    .filter((name) => names.has(name))
    .sort();
}

/** The fixtures still in Claude Code's own folder, by any means — link or folder. */
function claudeSkills(dir: string): string[] {
  return fixturesUnder(dir, '.claude', 'skills');
}

/** The fixtures that are real directories in the canonical layer. */
function canonicalSkills(dir: string): string[] {
  const root = join(dir, '.agents', 'skills');
  return fixturesUnder(dir, '.agents', 'skills').filter((name) =>
    lstatSync(join(root, name)).isDirectory()
  );
}

/** Every `logger.info` payload, so a line can be found by the field it carries. */
function infoPayloads(): Record<string, unknown>[] {
  return vi
    .mocked(logger.info)
    .mock.calls.map((call) => (call[1] ?? {}) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  dorkHome = mkdtempSync(join(tmpdir(), 'dorkos-auto-adopt-'));
  initConfigManager(dorkHome);
});

afterEach(() => {
  rmSync(dorkHome, { recursive: true, force: true });
});

describe('SRC-07: harness.autoAdopt off is the report-only posture', () => {
  it('SRC-07: finds every candidate in an agent home and moves none of them', async () => {
    // THE claim of this whole slice: the default posture reports and does not
    // touch. Seeded defect: default the flag to `true` and both the counts and
    // the tree change.
    expect(configManager.get('harness').autoAdopt).toBe(false);
    const agentDir = buildAgentHome('alpha');
    expect(claudeSkills(agentDir)).toEqual(['contexty', 'hooky', 'safe']);

    const summary = await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    expect(summary.adoptableSkills).toBe(3);
    expect(summary.adoptedSkills).toBe(0);
    // The tree, not just the counter: nothing left Claude Code's folder.
    expect(claudeSkills(agentDir)).toEqual(['contexty', 'hooky', 'safe']);
    expect(canonicalSkills(agentDir)).toEqual([]);
  });

  it('SRC-07: names all three in the boot log with the ABSOLUTE --project', async () => {
    const agentDir = buildAgentHome('alpha');

    await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    const line = infoPayloads().find((payload) => payload.adoptable === 3);
    expect(line).toBeDefined();
    expect(line?.agentDir).toBe(agentDir);
    expect(line?.skills).toEqual(['contexty', 'hooky', 'safe']);
    const lines = line?.adoptable_lines as string[];
    // Four: one headline (S1e) plus one command per skill, because a headline
    // cannot name three skills in one command.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      `3 skills live only in .claude/skills and Codex cannot see them — dorkos harness adopt <name> --project ${agentDir} moves one`
    );
    expect(lines.slice(1)).toEqual([
      `dorkos harness adopt contexty --project ${agentDir}`,
      `dorkos harness adopt hooky --project ${agentDir}`,
      `dorkos harness adopt safe --project ${agentDir}`,
    ]);
  });

  it('SRC-07: the summary hint says how many are left and where they are named', async () => {
    const agentDir = buildAgentHome('alpha');

    await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    const complete = vi
      .mocked(logger.info)
      .mock.calls.find(
        (call) => call[0] === '[HarnessSync] Agent workspace skill backfill complete'
      );
    expect(complete).toBeDefined();
    expect((complete?.[1] as { hint?: string }).hint).toBe(
      "3 skills in 1 agent folders live only in one agent tool's folder. Each is named above with its folder."
    );
  });
});

describe('SK-16: harness.autoAdopt on moves only what the allowlist recognises', () => {
  it('SK-16: moves the one allowlisted skill in an agent home and leaves the other two', async () => {
    // Seeded defect: swap the allowlist for a denylist of `context` and `paths`
    // and `hooky` moves — `adoptedSkills` goes to 2 and the tree changes. That
    // run is the allowlist-versus-denylist argument made mechanical.
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const agentDir = buildAgentHome('alpha');

    const summary = await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    expect(summary.adoptableSkills).toBe(3);
    expect(summary.adoptedSkills).toBe(1);
    expect(canonicalSkills(agentDir)).toEqual(['safe']);
    expect(claudeSkills(agentDir)).toEqual(['contexty', 'hooky', 'safe']);
    // `safe` is still AT `.claude/skills/safe` — as the link Claude Code reads
    // it through, not as the folder it came out of.
    expect(lstatSync(join(agentDir, '.claude', 'skills', 'safe')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(agentDir, '.claude', 'skills', 'hooky')).isDirectory()).toBe(true);
  });

  it('SK-16: refuses the `hooks:` skill with S7 and the dialect skill with S7, each naming its key', async () => {
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const agentDir = buildAgentHome('alpha');

    await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    const refusals = vi
      .mocked(logger.info)
      .mock.calls.filter(
        (call) => call[0] === '[HarnessSync] A skill in this agent workspace was not moved'
      )
      .map((call) => call[1] as { skill: string; reason: string });
    // How many, before anything about them: two refused, one moved, three found.
    expect(refusals).toHaveLength(2);
    expect(refusals.map((r) => r.skill).sort()).toEqual(['contexty', 'hooky']);
    expect(refusals.find((r) => r.skill === 'hooky')?.reason).toBe(
      '"hooky" uses hooks in its settings, which only Claude Code understands, so moving it would hand it to agents that can\'t run it properly. Run dorkos harness adopt hooky --claude-only to say it belongs to Claude Code, or take hooks out and adopt it.'
    );
    expect(refusals.find((r) => r.skill === 'contexty')?.reason).toBe(
      '"contexty" uses context in its settings, which only Claude Code understands, so moving it would hand it to agents that can\'t run it properly. Run dorkos harness adopt contexty --claude-only to say it belongs to Claude Code, or take context out and adopt it.'
    );
  });

  it('SK-16: the boot line names the two that are left, with their absolute commands', async () => {
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const agentDir = buildAgentHome('alpha');

    await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    const line = infoPayloads().find((payload) => payload.adoptable === 3);
    expect(line?.adopted).toBe(1);
    const lines = line?.adoptable_lines as string[];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      `2 skills live only in .claude/skills and Codex cannot see them — dorkos harness adopt <name> --project ${agentDir} moves one`
    );
    expect(lines.slice(1)).toEqual([
      `dorkos harness adopt contexty --project ${agentDir}`,
      `dorkos harness adopt hooky --project ${agentDir}`,
    ]);
  });
});

describe('SRC-11: harness.autoAdopt on in a room worktree', () => {
  it('SRC-11: refuses a reserved pack name with S4 and moves the authored one', () => {
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const reserved = OPERATING_SKILLS_PACK[0]!.name;
    const worktree = join(dorkHome, 'rooms', 'room-1', 'worktrees', 'agent-abc');
    mkdirSync(worktree, { recursive: true });
    buildWorkspace(worktree);
    // The three fixtures are replaced by the two this case is about.
    rmSync(join(worktree, '.claude', 'skills'), { recursive: true, force: true });
    mkdirSync(join(worktree, '.claude', 'skills'), { recursive: true });
    writeSkill(join(worktree, '.claude', 'skills'), 'safe', 'name: safe\ndescription: Portable\n');
    writeSkill(
      join(worktree, '.claude', 'skills'),
      reserved,
      `name: ${reserved}\ndescription: Portable\n`
    );

    // The ownership the caller resolves from the path, never asked of the engine.
    expect(resolveDirectoryOwnership(worktree, dorkHome)).toBe('room-worktree');
    const outcome = adoptInOwnedWorkspace(worktree, 'room-worktree');

    expect(outcome.adoptable).toBe(2);
    expect(outcome.adopted).toBe(1);
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0]).toEqual({
      name: reserved,
      reason: `"${reserved}" is one of the skills DorkOS puts in every room folder, so .agents/skills/${reserved} is hidden from git here and would be deleted when the room folder is cleaned up. Rename your skill and adopt it under the new name.`,
    });
    expect(canonicalSkills(worktree)).toEqual(['safe']);
  });

  it('SRC-11: the moved skill shows in git status and the link it left behind does not', () => {
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const worktree = join(dorkHome, 'rooms', 'room-1', 'worktrees', 'agent-abc');
    mkdirSync(worktree, { recursive: true });
    buildWorkspace(worktree);
    rmSync(join(worktree, '.claude', 'skills'), { recursive: true, force: true });
    mkdirSync(join(worktree, '.claude', 'skills'), { recursive: true });
    writeSkill(join(worktree, '.claude', 'skills'), 'safe', 'name: safe\ndescription: Portable\n');

    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: worktree, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    // The manager's own block, as it writes it: `/.claude/skills/` is hidden
    // because DorkOS generates every link in it, and `.agents/skills` is NOT,
    // because that is where a room authors skills of its own.
    writeFileSync(
      join(worktree, '.git', 'info', 'exclude'),
      ['/.claude/skills/', '/.agents/harness.manifest.json', ...SEEDED_PACK_EXCLUDES, ''].join('\n')
    );

    const outcome = adoptInOwnedWorkspace(worktree, 'room-worktree');
    expect(outcome.adopted).toBe(1);

    // `-uall` so untracked FILES are listed rather than the top folder they sit
    // in: `?? .agents/` would be true whether or not the skill landed.
    const status = git('status', '--porcelain', '-uall');
    expect(status).toContain('.agents/skills/safe/SKILL.md');
    expect(status).not.toContain('.claude/');
  });
});

describe('D3: the flag is inert where DorkOS does not own the directory', () => {
  it('D3: a plain project is `plain` ownership, whatever the flag says', () => {
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const plain = mkdtempSync(join(tmpdir(), 'dorkos-plain-'));
    try {
      expect(resolveDirectoryOwnership(plain, dorkHome)).toBe('plain');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('D3: no unprompted trigger reads harness.autoAdopt at all', () => {
    // Not a behaviour test but an ABSENCE test, and it is the one that makes the
    // inertness structural: `runAutoProjection`, the agent-created projection and
    // the `.agents/skills` watcher all run in directories a PERSON owns, and a
    // `true` there does nothing because there is no branch that could be
    // mis-written to make it do something. Seeded defect: read the flag in
    // `runAutoProjection` and this reds.
    const triggers = ['auto-project.ts', 'project-on-agent-created.ts', 'skills-watcher.ts'];
    for (const file of triggers) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, `${file} must not read harness.autoAdopt`).not.toContain('autoAdopt');
    }
    // And the two that DO, so the absence above cannot pass by the flag having
    // been renamed out from under it.
    for (const file of ['adopt-owned-workspace.ts']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source).toContain('autoAdopt');
    }
  });
});
