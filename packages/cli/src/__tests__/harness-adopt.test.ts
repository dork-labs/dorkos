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

import { runHarnessAdopt, parseHarnessAdoptArgs } from '../harness-adopt-command.js';
import { runHarnessSync, parseHarnessSyncArgs } from '../harness-sync-command.js';
import { runHarnessDispatcher } from '../commands/harness-dispatcher.js';
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
  it('SRC-07: takes one skill name, and the three flags', async () => {
    expect(parseHarnessAdoptArgs([NAME])).toEqual({
      name: NAME,
      claudeOnly: false,
      check: false,
    });
    expect(parseHarnessAdoptArgs([NAME, '--check', '--claude-only', '--project', '/x'])).toEqual({
      name: NAME,
      project: '/x',
      claudeOnly: true,
      check: true,
    });
  });

  it('SRC-07: refuses a bare adopt, and names the command that lists candidates', async () => {
    // A bare adopt that ACTED would be one keystroke away from the multi-adopt
    // this work deliberately does not ship.
    expect(() => parseHarnessAdoptArgs([])).toThrow(/Name the skill you want to move/);
    expect(() => parseHarnessAdoptArgs([])).toThrow(/dorkos harness sync --check/);
  });

  it('SRC-07: refuses two names rather than moving the first one', async () => {
    expect(() => parseHarnessAdoptArgs(['a', 'b'])).toThrow(/one skill at a time, and you named 2/);
  });

  it('SRC-07: names the command in an unknown-option error', async () => {
    expect(() => parseHarnessAdoptArgs([NAME, '--force'])).toThrow(
      /Unknown option for 'harness adopt': --force/
    );
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

  it('SRC-07: says S15b, and leaves no link, for a root every enabled tool reads past', async () => {
    // The same condition asserted on the filesystem and on the sentence, so a
    // run cannot promise a link it did not make.
    writeRepo(repo, { skillRoot: '.opencode/skills', harnesses: ['codex', 'opencode'] });
    process.chdir(repo);

    const result = await runHarnessAdopt(adoptArgs({ name: NAME }));

    expect(result).toEqual({ exitCode: 0 });
    expect(printed()).toContain(
      `Moved ${NAME} to .agents/skills/${NAME}, where every agent reads it.`
    );
    expect(printed()).not.toContain('Claude Code still finds it');
    expect(snapshotTree(repo).filter((line) => line.startsWith('.opencode'))).toEqual([
      '.opencode',
      '.opencode/skills',
    ]);
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

  it('SRC-07: --check exits 1 when the move would NOT work', async () => {
    // The asymmetry with `sync --check`, stated as a test: this command asks
    // "will it work?", so success is zero and a refusal is one.
    writeRepo(repo);
    process.chdir(repo);
    const before = snapshotTree(repo);

    const result = await runHarnessAdopt(adoptArgs({ name: 'no-such-skill', check: true }));

    expect(result).toEqual({ exitCode: 1 });
    expect(printed()).toContain('There is no skill called "no-such-skill" in .claude/skills.');
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

  it('SRC-07: --project from another folder produces the tree the same run inside does', async () => {
    const twin = createTempDir();
    try {
      writeRepo(repo);
      writeRepo(twin);

      process.chdir(repo);
      await runHarnessAdopt(adoptArgs({ name: NAME }));
      const fromInside = snapshotTree(repo);

      process.chdir(originalCwd);
      await runHarnessAdopt(adoptArgs({ name: NAME, project: twin }));

      expect(snapshotTree(twin)).toEqual(fromInside);
    } finally {
      fs.rmSync(twin, { recursive: true, force: true });
    }
  });

  it('SRC-07: reaches the dispatcher, which answers --help without touching the tree', async () => {
    writeRepo(repo);
    process.chdir(repo);
    const before = snapshotTree(repo);

    expect(await runHarnessDispatcher('adopt', ['--help'])).toBe(0);
    expect(printed()).toContain('dorkos harness adopt deploy-checklist');
    expect(snapshotTree(repo)).toEqual(before);

    expect(await runHarnessDispatcher('adopt', [NAME])).toBe(0);
    expect(snapshotTree(repo)).toContain(`.claude/skills/${NAME} -> ../../.agents/skills/${NAME}`);
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

  it('J-06: prints no block at all when every enabled tool can already see it', async () => {
    // The same tree, a Claude-Code-only manifest: a count of zero problems is
    // noise, and this block is not a drift report.
    writeRepo(repo, { harnesses: ['claude-code'] });
    process.chdir(repo);

    await runHarnessSync(parseHarnessSyncArgs(['--check']));

    expect(printed()).not.toContain('Skills only some of your agents can see');
    expect(printed()).not.toContain('dorkos harness adopt');
  });

  it('J-06: at n>1 counts the skills and gives each its own command', async () => {
    writeRepo(repo, { harnesses: ALL_SIX, names: ['alpha', 'beta', 'gamma'] });
    process.chdir(repo);

    await runHarnessSync(parseHarnessSyncArgs(['--check']));

    expect(printed()).toContain(
      '  3 skills live only in .claude/skills and Codex and Gemini CLI cannot see them — ' +
        'dorkos harness adopt <name> moves one'
    );
    expect(printed()).toContain('    dorkos harness adopt alpha');
    expect(printed()).toContain('    dorkos harness adopt beta');
    expect(printed()).toContain('    dorkos harness adopt gamma');
  });

  it('J-06: names one root per headline, computed per root', async () => {
    writeRepo(repo, { harnesses: ALL_SIX, names: ['alpha'] });
    writeRepo(repo, { skillRoot: '.opencode/skills', harnesses: ALL_SIX, names: ['beta'] });
    process.chdir(repo);

    await runHarnessSync(parseHarnessSyncArgs(['--check']));

    expect(printed()).toContain(
      '  1 skill lives only in .claude/skills and Codex and Gemini CLI cannot see it — ' +
        'dorkos harness adopt alpha moves it'
    );
    expect(printed()).toContain(
      '  1 skill lives only in .opencode/skills and Claude Code, Codex, Cursor, Gemini CLI and ' +
        'Copilot cannot see it — dorkos harness adopt beta moves it'
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
