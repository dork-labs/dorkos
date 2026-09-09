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
import {
  HARNESS_NATIVE_SKILL_ROOTS,
  harnessesThatCannotSee,
  type SkillRoot,
} from '@dorkos/harness';
import { RUNNABLE_HARNESSES } from '@dorkos/shared/harness-schemas';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  AGENT_WORKSPACE_HARNESSES,
  backfillAgentWorkspaceSkills,
} from '../project-agent-workspace.js';
import { adoptInOwnedWorkspace } from '../adopt-owned-workspace.js';
import { resolveDirectoryOwnership } from '../directory-ownership.js';
import { initConfigManager, configManager } from '../../core/config-manager.js';
import { logger } from '../../../lib/logger.js';
import { SEEDED_PACK_EXCLUDES } from '../../rooms/repo/room-worktree-manager.js';
import { RoomRepoStore } from '../../rooms/repo/room-repo-store.js';

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
const CLAUDE_SKILLS_ROOT: SkillRoot = '.claude/skills';

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
 * canonical layer so the projection runs, and **the manifest DorkOS actually
 * scaffolds into a workspace it owns**.
 *
 * `AGENT_WORKSPACE_HARNESSES` rather than a hand-written list, and that is the
 * whole point of this helper: every case here used to write
 * `['claude-code', 'codex']`, which no real agent home has. A filter keyed off
 * the manifest therefore looked live in the suite and was dead on disk.
 */
function buildWorkspace(
  dir: string,
  harnesses: readonly string[] = AGENT_WORKSPACE_HARNESSES
): string {
  mkdirSync(join(dir, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  writeFileSync(
    join(dir, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses }, null, 2)
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
 * One skill in Claude Code's own folder, in a workspace whose manifest enables
 * the harnesses given — `['claude-code']` being the case where every enabled
 * tool can already see it.
 */
function buildAgentHomeWith(
  name: string,
  harnesses: readonly string[],
  skills: readonly { name: string; frontmatter: string }[]
): string {
  const dir = join(dorkHome, 'agents', name);
  mkdirSync(join(dir, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  writeFileSync(
    join(dir, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses }, null, 2)
  );
  for (const skill of skills)
    writeSkill(join(dir, '.claude', 'skills'), skill.name, skill.frontmatter);
  return dir;
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
      "3 skills in 1 agent folder live only in one agent tool's folder. Each is named above with its folder."
    );
  });

  it('SRC-07: the hint counts in singulars when there is one of each', async () => {
    // "1 skills in 1 agent folders" is a sentence a person reads in a log line,
    // and this repository's writing bar covers it. Measured in the seam before
    // it was fixed.
    const agentDir = join(dorkHome, 'agents', 'solo');
    mkdirSync(join(agentDir, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
    writeFileSync(
      join(agentDir, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
    );
    writeSkill(join(agentDir, '.claude', 'skills'), 'safe', 'name: safe\ndescription: Portable\n');

    const summary = await backfillAgentWorkspaceSkills([agentDir], dorkHome);
    expect(summary.adoptableSkills).toBe(1);

    const complete = vi
      .mocked(logger.info)
      .mock.calls.find(
        (call) => call[0] === '[HarnessSync] Agent workspace skill backfill complete'
      );
    expect((complete?.[1] as { hint?: string }).hint).toBe(
      "1 skill in 1 agent folder lives only in one agent tool's folder. Each is named above with its folder."
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
  it('SRC-11: the shape it recognises is the one the store actually lays down', () => {
    // The resolver matches `<dorkHome>/rooms/<id>/worktrees/<slug>` by shape, and
    // a shape is only worth matching while it is the shape that exists. Asked of
    // `RoomRepoStore` itself rather than spelled a second time here, so moving
    // the layout reds this instead of silently making every room worktree read
    // as somebody's own project — where `harness.autoAdopt` does nothing and R3
    // never fires. `worktreesPath` touches no database.
    const store = new RoomRepoStore(undefined as never, dorkHome);
    const worktree = join(store.worktreesPath('room-1'), 'agent-abc');

    expect(resolveDirectoryOwnership(worktree, dorkHome)).toBe('room-worktree');
    // And one rung either side, so the match is the shape rather than a prefix.
    expect(resolveDirectoryOwnership(store.worktreesPath('room-1'), dorkHome)).toBe('plain');
    expect(resolveDirectoryOwnership(join(worktree, 'nested'), dorkHome)).toBe('plain');
  });

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

describe('SRC-07: the summary counts only folders that still have something to say', () => {
  it('SRC-07: a folder whose only candidate was adopted is not counted in the hint', async () => {
    // What this catches: `M` counted every folder that HAD a candidate, so a
    // pass that moved the only one in a folder still said "in 2 agent folders"
    // and sent the reader looking for a line that was never printed. Seeded
    // defect: count on `adopt.adoptable > 0` again and the sentence reds.
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const moved = buildAgentHomeWith('alpha', ['claude-code', 'codex'], [CANDIDATES[0]!]);
    const left = buildAgentHomeWith('beta', ['claude-code', 'codex'], [CANDIDATES[1]!]);

    const summary = await backfillAgentWorkspaceSkills([moved, left], dorkHome);

    expect(summary.adoptableSkills).toBe(2);
    expect(summary.adoptedSkills).toBe(1);
    const complete = vi
      .mocked(logger.info)
      .mock.calls.find(
        (call) => call[0] === '[HarnessSync] Agent workspace skill backfill complete'
      );
    expect((complete?.[1] as { hint?: string }).hint).toBe(
      "1 skill in 1 agent folder lives only in one agent tool's folder. Each is named above with its folder."
    );
  });
});

describe('SRC-07: the manifest is not the oracle in a folder DorkOS owns', () => {
  it('SRC-07: the scaffolded claude-code-only workspace still counts, reports and moves', async () => {
    // THE regression this describe exists for. A workspace DorkOS scaffolds
    // enables `claude-code` alone, so asking the MANIFEST who cannot see a
    // `.claude/skills` skill answers "nobody" — true about projection, false
    // about the agent, since `runtimeRegistry` binds a session and the same
    // agent's next Codex session reads none of it. Keying the question off the
    // manifest made every real agent home a silent no-op: nothing counted,
    // nothing reported, nothing moved. Seeded defect: ask
    // `read.enabledHarnesses` instead of `RUNNABLE_HARNESSES` and all four
    // assertions below go to zero.
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const agentDir = buildAgentHomeWith('solo', AGENT_WORKSPACE_HARNESSES, [...CANDIDATES]);
    expect(
      JSON.parse(readFileSync(join(agentDir, '.agents', 'harness.manifest.json'), 'utf8'))
    ).toMatchObject({ harnesses: ['claude-code'] });

    const summary = await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    expect(summary.adoptableSkills).toBe(3);
    expect(summary.adoptedSkills).toBe(1);
    expect(canonicalSkills(agentDir)).toEqual(['safe']);
    const line = infoPayloads().find((payload) => payload.adoptable === 3);
    expect(line?.adoptable_lines).toContain(
      `2 skills live only in .claude/skills and Codex cannot see them — dorkos harness adopt <name> --project ${agentDir} moves one`
    );
  });

  it('SRC-07: with the flag off the same workspace reports every one and moves none', async () => {
    const agentDir = buildAgentHomeWith('solo', AGENT_WORKSPACE_HARNESSES, [...CANDIDATES]);

    const summary = await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    expect(summary.adoptableSkills).toBe(3);
    expect(summary.adoptedSkills).toBe(0);
    expect(canonicalSkills(agentDir)).toEqual([]);
    const line = infoPayloads().find((payload) => payload.adoptable === 3);
    expect(line?.adoptable_lines).toContain(
      `3 skills live only in .claude/skills and Codex cannot see them — dorkos harness adopt <name> --project ${agentDir} moves one`
    );
  });

  it('SRC-07: the scaffold the pass itself writes is the one this suite is measured against', async () => {
    // No hand-written manifest anywhere in this case: the workspace arrives with
    // skills and nothing else, and `projectAgentWorkspace` scaffolds the harness
    // set DorkOS really uses. Every other agent-home fixture here used to write
    // `['claude-code', 'codex']`, which no agent home has ever had — which is
    // exactly how a filter that was dead on disk stayed green in the suite.
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const agentDir = join(dorkHome, 'agents', 'scaffolded');
    mkdirSync(join(agentDir, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
    for (const candidate of CANDIDATES) {
      writeSkill(join(agentDir, '.claude', 'skills'), candidate.name, candidate.frontmatter);
    }
    expect(existsSync(join(agentDir, '.agents', 'harness.manifest.json'))).toBe(false);

    const summary = await backfillAgentWorkspaceSkills([agentDir], dorkHome);

    // What DorkOS actually scaffolded, read back rather than assumed.
    expect(
      JSON.parse(readFileSync(join(agentDir, '.agents', 'harness.manifest.json'), 'utf8'))
    ).toMatchObject({ harnesses: [...AGENT_WORKSPACE_HARNESSES] });
    expect(summary.adoptableSkills).toBe(3);
    expect(summary.adoptedSkills).toBe(1);
    expect(canonicalSkills(agentDir)).toEqual(['safe']);
  });

  it('SRC-07: what it counts and what it names are one set, per root', () => {
    // The count and the sentence are computed from one filter, so they cannot
    // disagree about which skills are on offer. Asserted as a property over the
    // roots the engine knows rather than as a fixture, because which harness
    // reads which folder is a vendor fact that moves.
    for (const root of [CLAUDE_SKILLS_ROOT, ...HARNESS_NATIVE_SKILL_ROOTS]) {
      const cannotSee = harnessesThatCannotSee(root, RUNNABLE_HARNESSES);
      expect(
        { root, someRunnableHarnessIsBlind: cannotSee.length > 0 },
        `${root}: a root every runnable harness reads would be counted and never named`
      ).toEqual({ root, someRunnableHarnessIsBlind: true });
    }
  });
});

describe('AP-15: a folder that cannot take a moved skill says so once', () => {
  it('AP-15: logs the run-level refusal on its own line, with no skill name on it', () => {
    // A gitignored `.agents/` stops every candidate at once, and the sentence is
    // about the DIRECTORY. It used to travel as a refusal with `skill: ''`,
    // which reads as a refusal that lost the skill it was about — and the way
    // out is in the sentence, so it must not be swallowed either.
    configManager.set('harness', { ...configManager.get('harness'), autoAdopt: true });
    const agentDir = buildAgentHome('alpha');
    execFileSync('git', ['init', '-q'], { cwd: agentDir });
    writeFileSync(join(agentDir, '.gitignore'), '.agents/\n');

    const outcome = adoptInOwnedWorkspace(agentDir, 'agent-home');

    expect(outcome.adoptable).toBe(3);
    expect(outcome.adopted).toBe(0);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.blocked).toBe(
      "DorkOS can't move a skill into .agents/skills here: .gitignore tells git to ignore .agents/, so moving it would take the skill out of git for everybody who clones this project. Stop ignoring .agents/ in .gitignore, or leave the skill where it is."
    );
    expect(canonicalSkills(agentDir)).toEqual([]);
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

  it('D3: no unprompted trigger reads harness.autoAdopt, by name or through the module that does', () => {
    // Not a behaviour test but an ABSENCE test, and it is the one that makes the
    // inertness structural: `runAutoProjection`, the agent-created projection and
    // the `.agents/skills` watcher all run in directories a PERSON owns, and a
    // `true` there does nothing because there is no branch that could be
    // mis-written to make it do something.
    //
    // **Both spellings are asserted, because the first one alone is not an
    // absence.** Grepping for the literal `autoAdopt` misses the way a trigger
    // would ACTUALLY grow this: one call to `adoptInOwnedWorkspace`, which reads
    // the flag on the trigger's behalf and never says its name. Seeded defect:
    // either read the flag in `runAutoProjection` or import that module there —
    // one of the two assertions catches each.
    const triggers = ['auto-project.ts', 'project-on-agent-created.ts', 'skills-watcher.ts'];
    for (const file of triggers) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, `${file} must not read harness.autoAdopt`).not.toContain('autoAdopt');
      expect(source, `${file} must not reach the flag through adopt-owned-workspace`).not.toContain(
        'adopt-owned-workspace'
      );
      expect(source, `${file} must not call adoptInOwnedWorkspace`).not.toContain(
        'adoptInOwnedWorkspace'
      );
    }
    // And the module that DOES, so the absences above cannot pass by the flag or
    // the entry point having been renamed out from under them.
    const owner = readFileSync(new URL('../adopt-owned-workspace.ts', import.meta.url), 'utf8');
    expect(owner).toContain('autoAdopt');
    expect(owner).toContain('adoptInOwnedWorkspace');
  });
});
