/**
 * SRC-07 — `dorkos harness adopt`, over real temp repositories.
 *
 * Every exit code is PAIRED with a whole-tree snapshot, which is the idiom
 * `harness-sync.test.ts` established after DOR-678: an exit-code-only test
 * passed throughout the life of that bug, and "writes nothing" is a claim about
 * a tree rather than about a number.
 *
 * The snapshots hash file contents (`snapshotTree`, this suite's sibling), so
 * "the tree did not change" means the same bytes are in the same places rather
 * than paths with the same names — which is the difference that matters for a
 * command whose whole job is moving somebody's files.
 *
 * @module __tests__/harness-adopt
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { ROOM_SEEDED_SKILL_NAMES } from '@dorkos/harness';

import { runHarnessAdopt, parseHarnessAdoptArgs } from '../harness-adopt-command.js';
import { runHarnessSync, parseHarnessSyncArgs } from '../harness-sync-command.js';
import { createTempDir, pinEmptyClaudeRoot, syncArgs } from './harness-fixtures.js';

/** The skill most cases are about. */
const NAME = 'deploy-checklist';

/** Every enabled agent tool, in the order a manifest lists them. */
const ALL_SIX = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'opencode'];

/**
 * Every path under `root`, each carrying what is at it — the same measure
 * `harness-sync.test.ts` uses, and for the same reason.
 *
 * @param root - the directory to walk.
 * @returns one sorted line per path, files hashed and links read.
 */
function snapshotTree(root: string): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) return [`${rel} -> ${fs.readlinkSync(abs)}`];
        if (entry.isDirectory()) return [rel, ...walk(abs, rel)];
        return [`${rel} ${createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`];
      })
      .sort();
  return walk(root, '');
}

/**
 * Fill in the flags a case does not care about.
 *
 * @param partial - the flags this case is actually about.
 * @returns a complete argument object.
 */
function adoptArgs(partial: Partial<Parameters<typeof runHarnessAdopt>[0]> & { name: string }) {
  return { claudeOnly: false, check: false, ...partial };
}

/**
 * A repository with a manifest and one skill in a harness-owned root.
 *
 * @param root - where to write the skill.
 * @param options - the harnesses the manifest enables, the skill names, and any
 *   extra frontmatter lines.
 */
function writeRepo(
  root: string,
  options: {
    skillRoot?: string;
    harnesses?: string[];
    names?: string[];
    frontmatter?: string;
  } = {}
): void {
  const {
    skillRoot = '.claude/skills',
    harnesses = ['claude-code', 'codex'],
    names = [NAME],
    frontmatter = '',
  } = options;
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'harness.manifest.json'),
    `${JSON.stringify({ version: 1, harnesses }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nCanonical instructions.\n');
  for (const name of names) {
    fs.mkdirSync(path.join(root, ...skillRoot.split('/'), name), { recursive: true });
    fs.writeFileSync(
      path.join(root, ...skillRoot.split('/'), name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: What ${name} does\n${frontmatter}---\n\nStep one.\n`
    );
  }
}

describe('parseHarnessAdoptArgs', () => {
  it('SRC-07: refuses a bare adopt, and names the command that lists candidates', async () => {
    // A bare adopt that ACTED would be one keystroke away from the multi-adopt
    // this work deliberately does not ship.
    expect(() => parseHarnessAdoptArgs([])).toThrow(/Name the skill you want to move/);
    expect(() => parseHarnessAdoptArgs([])).toThrow(/dorkos harness sync --check/);
  });
});

describe('runHarnessAdopt', () => {
  let repo: string;
  let homeDir: string;
  let originalCwd: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    pinEmptyClaudeRoot(homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  /** Everything printed to stdout so far, as one string. */
  const printed = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

  /** Everything printed to stderr so far, as one string. */
  const printedErrors = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

  it('SRC-11: refuses a reserved pack name when the folder IS a room worktree', async () => {
    // The terminal resolves ownership from the path, by the same function the
    // server uses (DOR-1945) — so standing in a room's working copy gets R3's
    // refusal rather than a move the reap would delete. Seeded defect: hard-code
    // `ownership: 'plain'` back into the command and this skill moves.
    const reserved = [...ROOM_SEEDED_SKILL_NAMES].sort()[0]!;
    const worktree = path.join(homeDir, 'rooms', 'room-1', 'worktrees', 'agent-abc');
    fs.mkdirSync(worktree, { recursive: true });
    writeRepo(worktree, { names: [reserved] });
    process.chdir(worktree);
    const before = snapshotTree(worktree);

    const result = await runHarnessAdopt(adoptArgs({ name: reserved }));

    expect(result).toEqual({ exitCode: 1 });
    expect(printed()).toContain(
      `"${reserved}" is one of the skills DorkOS puts in every room folder, so ` +
        `.agents/skills/${reserved} is hidden from git here and would be deleted when the room ` +
        `folder is cleaned up. Rename your skill and adopt it under the new name.`
    );
    expect(snapshotTree(worktree)).toEqual(before);
  });

  it('SRC-07: --check says what would happen, exits 0, and writes nothing', async () => {
    writeRepo(repo);
    process.chdir(repo);
    const before = snapshotTree(repo);

    const result = await runHarnessAdopt(adoptArgs({ name: NAME, check: true }));

    expect(result).toEqual({ exitCode: 0 });
    expect(printed()).toContain(
      `Would move .claude/skills/${NAME} to .agents/skills/${NAME}, and leave a link at ` +
        `.claude/skills/${NAME} so Claude Code still finds it.`
    );
    expect(printed()).toContain('--check wrote nothing.');
    // MEASURED, not promised.
    expect(snapshotTree(repo)).toEqual(before);
  });

  it('SRC-07: moves the skill, says so in S15, and exits 0', async () => {
    writeRepo(repo);
    process.chdir(repo);

    const result = await runHarnessAdopt(adoptArgs({ name: NAME }));

    expect(result).toEqual({ exitCode: 0 });
    expect(printed()).toContain(
      `Moved ${NAME} to .agents/skills/${NAME}. Claude Code still finds it through a link at ` +
        `.claude/skills/${NAME}.`
    );
    expect(snapshotTree(repo)).toContain(`.claude/skills/${NAME} -> ../../.agents/skills/${NAME}`);
  });

  it('SRC-07: exits 1 on a refusal, and the tree is byte-for-byte what it was', async () => {
    writeRepo(repo);
    // Something is already at the target, which is R4. Neither a skill nor a
    // file, deliberately: a real skill of that name in the canonical layer is a
    // DUPLICATE, which R1 answers with its own sentence, and a file there is a
    // hostile write path, which R2 answers with DOR-1882's.
    fs.mkdirSync(path.join(repo, '.agents', 'skills', NAME), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'skills', NAME, 'notes.txt'), 'half-written\n');
    process.chdir(repo);
    const before = snapshotTree(repo);

    const result = await runHarnessAdopt(adoptArgs({ name: NAME }));

    expect(result).toEqual({ exitCode: 1 });
    expect(printed()).toContain(
      `.agents/skills/${NAME} already has something in it. Look at both copies, keep the one you ` +
        `want, and adopt again.`
    );
    expect(snapshotTree(repo)).toEqual(before);
  });

  it('SRC-07: stops on a project with no manifest, and never scaffolds one', async () => {
    fs.mkdirSync(path.join(repo, '.claude', 'skills', NAME), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'skills', NAME, 'SKILL.md'), '# x\n');
    process.chdir(repo);
    const before = snapshotTree(repo);

    const result = await runHarnessAdopt(adoptArgs({ name: NAME }));

    expect(result).toEqual({ exitCode: 1 });
    expect(printedErrors()).toContain('No harness manifest in');
    expect(printedErrors()).toContain('.agents/harness.manifest.json');
    expect(snapshotTree(repo)).toEqual(before);
  });

  it('SRC-07: --claude-only writes ONE manifest element and leaves every other byte', async () => {
    writeRepo(repo, { frontmatter: 'hooks:\n  Stop: echo done\n' });
    process.chdir(repo);
    const manifest = path.join(repo, '.agents', 'harness.manifest.json');
    const before = fs.readFileSync(manifest, 'utf8');
    const skillBefore = snapshotTree(path.join(repo, '.claude'));

    const result = await runHarnessAdopt(adoptArgs({ name: NAME, claudeOnly: true }));

    expect(result).toEqual({ exitCode: 0 });
    const after = fs.readFileSync(manifest, 'utf8');
    const inserted = [
      ',',
      '  "claudeOnlySkills": [{',
      `    "name": "${NAME}",`,
      `    "path": ".claude/skills/${NAME}",`,
      '    "reason": "Kept in Claude Code: its settings use hooks, which only Claude Code understands."',
      '  }]',
    ].join('\n');
    expect(after.replace(inserted, '')).toBe(before);
    // And the skill did not move.
    expect(snapshotTree(path.join(repo, '.claude'))).toEqual(skillBefore);
    expect(printed()).toContain(
      `Recorded ${NAME} as belonging to Claude Code. It stays in .claude/skills/${NAME}, and ` +
        `your other agents are told why they don't get it.`
    );
  });

  it('SRC-11: moves the same reserved name in a folder DorkOS does not own', async () => {
    // The other half of the pair, so the case above is about the PLACE rather
    // than about the name: the identical skill in somebody's own project is a
    // skill they may move.
    const reserved = [...ROOM_SEEDED_SKILL_NAMES].sort()[0]!;
    writeRepo(repo, { names: [reserved] });
    process.chdir(repo);

    const result = await runHarnessAdopt(adoptArgs({ name: reserved }));

    expect(result).toEqual({ exitCode: 0 });
    expect(fs.existsSync(path.join(repo, '.agents', 'skills', reserved))).toBe(true);
  });
});

describe('J-06 — the sync report names the skills only some agents can see', () => {
  let repo: string;
  let homeDir: string;
  let originalCwd: string;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    pinEmptyClaudeRoot(homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  /** Everything printed to stdout so far, as one string. */
  const printed = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

  it('J-06: prints the contract’s own sentence at n=1, in --check and in --fix', async () => {
    // Seeded defect: hard-code "Codex and Gemini CLI" instead of computing the
    // list, and the Claude-Code-only case below reds.
    writeRepo(repo, { harnesses: ALL_SIX });
    process.chdir(repo);

    await runHarnessSync(parseHarnessSyncArgs(['--check']));

    expect(printed()).toContain('Skills only some of your agents can see:');
    expect(printed()).toContain(
      `  1 skill lives only in .claude/skills and Codex and Gemini CLI cannot see it — ` +
        `dorkos harness adopt ${NAME} moves it`
    );

    logSpy.mockClear();
    await runHarnessSync(syncArgsFix());
    expect(printed()).toContain(
      `  1 skill lives only in .claude/skills and Codex and Gemini CLI cannot see it — ` +
        `dorkos harness adopt ${NAME} moves it`
    );
  });

  it('J-06: goes quiet the moment the skill is adopted, and the next check is clean', async () => {
    // The whole promise of the design in one run: a synced repository, one
    // adopt, and the very next `--check` has nothing to say — no drift, no
    // orphan, and no headline about a skill only some tools can read.
    writeRepo(repo, { harnesses: ALL_SIX });
    process.chdir(repo);
    await runHarnessSync(syncArgsFix());

    await runHarnessAdopt(adoptArgs({ name: NAME }));
    logSpy.mockClear();
    const exit = await runHarnessSync(parseHarnessSyncArgs(['--check']));

    expect(printed()).not.toContain('Skills only some of your agents can see');
    expect(printed()).toContain('No drift — every projection already matches the plan.');
    expect(exit).toEqual({ exitCode: 0 });
  });
});

/** `--fix`, with every other flag at its default. */
function syncArgsFix() {
  return syncArgs({ fix: true });
}
