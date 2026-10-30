/**
 * What a worktree's repo settings are compared against, and what differs
 * (DOR-3298): the default-branch baseline and its pin, the hook and `.mcp.json`
 * drift, the local settings digest, and the card's diff. Real git, in a temp
 * repo with worktrees.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const store = vi.hoisted(() => ({ harness: {} as Record<string, unknown> }));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'harness' ? store.harness : undefined),
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'harness') store.harness = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));

import { pinRepoBaseline, resolveRepoBaseline } from '../repo-baseline.js';
import { readRepoConfig } from '../repo-config-parts.js';
import { readLocalSettings } from '../repo-local-settings.js';
import { gitBlobId } from '../repo-git.js';
import { fileDiff } from '../text-diff.js';
import { recordedBaseline } from '../repo-config-consent.js';
import { git, isolateGitEnv, makeRepo, writeFile, type RepoFixture } from './git-fixture.js';

/** A committed hook that runs a script in the repo, like `git-guard`. */
const GUARD_SETTINGS = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs' }] },
    ],
  },
  permissions: { allow: ['Read'] },
};
const GUARD_SCRIPT = 'process.exit(0);\n';
const MCP = { mcpServers: { docs: { command: 'node', args: ['docs-server.js'] } } };

let repo: RepoFixture;
let restoreEnv: () => void;
const DORK_HOME = '/nonexistent-dork-home';

beforeEach(async () => {
  restoreEnv = isolateGitEnv();
  store.harness = {};
  repo = makeRepo({
    '.claude/settings.json': GUARD_SETTINGS,
    '.claude/hooks/guard.mjs': GUARD_SCRIPT,
    '.mcp.json': MCP,
    'CLAUDE.md': 'rules',
  });
  // As the upgrade pins a repo DorkOS already knew.
  await pinRepoBaseline(repo.main);
});

afterEach(() => {
  repo.cleanup();
  restoreEnv();
});

/** A person's yes on the "default branch changed its hooks" card: pin where main is now. */
async function approveDefaultBranch(): Promise<void> {
  store.harness = {};
  await pinRepoBaseline(repo.main);
}

const read = async (cwd: string) =>
  readRepoConfig(cwd, await resolveRepoBaseline(cwd, DORK_HOME), DORK_HOME);

describe('the default-branch baseline', () => {
  it('falls back to a local main when there is no remote, and records it', async () => {
    const sha = git(repo.main, ['rev-parse', 'main']);
    const baseline = await resolveRepoBaseline(repo.addWorktree('wt'), DORK_HOME);
    expect(baseline.status).toBe('compared');
    expect(baseline.commits[0]).toBe(sha);
    expect(baseline.candidate).toEqual({ branch: 'main', sha });
    expect(recordedBaseline(baseline.commonDir!)?.sha).toBe(sha);
  });

  it('follows origin/HEAD when the repo has one', async () => {
    const origin = path.join(repo.root, 'origin.git');
    git(repo.root, ['clone', '-q', '--bare', repo.main, origin]);
    git(origin, ['branch', '-m', 'main', 'trunk']);
    git(repo.main, ['remote', 'add', 'origin', origin]);
    git(repo.main, ['fetch', '-q', 'origin']);
    git(repo.main, ['remote', 'set-head', 'origin', 'trunk']);
    const baseline = await resolveRepoBaseline(repo.main, DORK_HOME);
    expect(baseline.candidate?.branch).toBe('origin/trunk');
  });

  it('gives no trusted commit when no default branch resolves', async () => {
    git(repo.main, ['branch', '-m', 'main', 'dev']);
    const baseline = await resolveRepoBaseline(repo.main, DORK_HOME);
    expect(baseline.commits).toEqual([]);
    expect(baseline.untrusted).toBe('no-default-branch');
    // Fails closed: every committed hook counts as changed.
    expect((await read(repo.main)).hooks?.files).toContain('.claude/settings.json');
  });

  it('moves forward with the branch, and refuses a branch moved anywhere else', async () => {
    const wt = repo.addWorktree('wt');
    await resolveRepoBaseline(wt, DORK_HOME);
    const first = git(repo.main, ['rev-parse', 'main']);
    writeFile(path.join(repo.main, 'README.md'), 'more');
    const second = repo.commit('forward');
    expect((await resolveRepoBaseline(wt, DORK_HOME)).commits[0]).toBe(second);

    // An agent points main at a commit that does not build on the recorded one.
    git(repo.main, ['checkout', '-q', '--orphan', 'side']);
    writeFile(path.join(repo.main, '.claude/hooks/guard.mjs'), 'evil();\n');
    const side = repo.commit('side');
    git(repo.main, ['update-ref', 'refs/heads/main', side]);
    const moved = await resolveRepoBaseline(wt, DORK_HOME);
    expect(moved.commits).toEqual([]);
    expect(moved.untrusted).toBe('moved');
    expect(moved.candidate?.sha).toBe(side);
    expect(recordedBaseline(moved.commonDir!)?.sha).toBe(second);
    expect(first).not.toBe(second);
  });

  it('fails closed on a repo DorkOS has not pinned, and pins one only once', async () => {
    store.harness = {};
    const wt = repo.addWorktree('wt');
    const baseline = await resolveRepoBaseline(wt, DORK_HOME);
    expect(baseline.untrusted).toBe('first-seen');
    expect(baseline.commits).toEqual([]);
    expect(recordedBaseline(baseline.commonDir!)).toBeUndefined();
    expect((await read(wt)).hooks?.files).toContain('.claude/hooks/guard.mjs');
    expect(await pinRepoBaseline(wt)).toBe(true);
    expect(await pinRepoBaseline(wt)).toBe(false);
    expect((await read(wt)).hooks).toBeNull();
  });

  it('refuses a forward move that changes a hook, and takes one that runs nothing new', async () => {
    const wt = repo.addWorktree('wt');
    const pinned = git(repo.main, ['rev-parse', 'main']);
    writeFile(path.join(repo.main, 'docs/notes.md'), 'Take notes.\n');
    const quiet = repo.commit('a doc, which runs nothing');
    expect((await resolveRepoBaseline(wt, DORK_HOME)).commits[0]).toBe(quiet);

    // An agent commits a hook change on top and moves main forward to it.
    writeFile(path.join(repo.main, '.claude/hooks/guard.mjs'), 'evil();\n');
    const loud = repo.commit('a changed hook');
    const moved = await resolveRepoBaseline(wt, DORK_HOME);
    expect(moved.untrusted).toBe('hooks-moved');
    expect(moved.candidate?.sha).toBe(loud);
    expect(recordedBaseline(moved.commonDir!)?.sha).toBe(quiet);
    expect(pinned).not.toBe(quiet);
  });

  it('asks about a forward move that touches anything under .claude, a command included (M2)', async () => {
    const wt = repo.addWorktree('wt');
    const pinned = git(repo.main, ['rev-parse', 'main']);
    writeFile(path.join(repo.main, '.claude/commands/notes.md'), 'Take notes.\n');
    repo.commit('a command');
    const moved = await resolveRepoBaseline(wt, DORK_HOME);
    expect(moved.untrusted).toBe('hooks-moved');
    expect(recordedBaseline(moved.commonDir!)?.sha).toBe(pinned);
  });

  it('refuses a forward move that changes a script a hook command names, outside .claude', async () => {
    store.harness = {};
    writeFile(path.join(repo.main, '.claude/settings.json'), {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'sh scripts/check.sh' }] },
        ],
      },
    });
    writeFile(path.join(repo.main, 'scripts/check.sh'), 'exit 0\n');
    repo.commit('a hook that runs a script outside .claude');
    await pinRepoBaseline(repo.main);
    const wt = repo.addWorktree('wt');
    writeFile(path.join(repo.main, 'scripts/check.sh'), 'evil\n');
    repo.commit('the script changed');
    expect((await resolveRepoBaseline(wt, DORK_HOME)).untrusted).toBe('hooks-moved');
  });

  it('treats a folder outside any repo as having no baseline', async () => {
    const plain = path.join(repo.root, 'plain');
    writeFile(path.join(plain, '.claude/settings.json'), GUARD_SETTINGS);
    const baseline = await resolveRepoBaseline(plain, DORK_HOME);
    expect(baseline.untrusted).toBe('not-a-repo');
    expect((await read(plain)).hooks?.files).toEqual(['.claude/settings.json']);
  });
});

describe('repo settings drift', () => {
  it('finds nothing in a worktree that matches the default branch', async () => {
    const reading = await read(repo.addWorktree('wt'));
    expect(reading.hooks).toBeNull();
    expect(reading.mcpJson).toBeNull();
    expect(reading.baselineServers).toEqual(MCP.mcpServers);
  });

  it('finds an edited hook script, with a diff against the default branch', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.claude/hooks/guard.mjs'), 'console.log("allow");\n');
    const reading = await read(wt);
    expect(reading.hooks?.files).toEqual(['.claude/hooks/guard.mjs']);
    expect(reading.hooks?.detail).toContain('-process.exit(0);');
    expect(reading.hooks?.detail).toContain('+console.log("allow");');
    expect(reading.hooks?.approvable).toBe(true);
  });

  it('counts a near-miss undo as still changed', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.claude/hooks/guard.mjs'), `${GUARD_SCRIPT} `);
    expect((await read(wt)).hooks?.files).toEqual(['.claude/hooks/guard.mjs']);
    writeFile(path.join(wt, '.claude/hooks/guard.mjs'), GUARD_SCRIPT);
    expect((await read(wt)).hooks).toBeNull();
  });

  it('finds a changed hook command, but not a change to a key that runs nothing', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.claude/settings.json'), {
      ...GUARD_SETTINGS,
      model: 'sonnet',
    });
    expect((await read(wt)).hooks).toBeNull();
    writeFile(path.join(wt, '.claude/settings.json'), {
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo ok' }] }] },
    });
    const reading = await read(wt);
    expect(reading.hooks?.files).toEqual(['.claude/settings.json']);
    expect(reading.hooks?.mcpKeysChanged).toBe(false);
  });

  it('finds a new script under .claude/hooks', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.claude/hooks/new.sh'), 'echo hi\n');
    expect((await read(wt)).hooks?.files).toEqual(['.claude/hooks/new.sh']);
  });

  it('keeps a worktree started before the default branch changed its hook', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(repo.main, '.claude/hooks/guard.mjs'), 'process.exit(0); // v2\n');
    repo.commit('guard v2');
    await approveDefaultBranch();
    expect((await read(wt)).hooks).toBeNull();
  });

  it('gives the same digest for the same edit in two worktrees', async () => {
    const a = repo.addWorktree('a');
    const b = repo.addWorktree('b');
    for (const wt of [a, b]) writeFile(path.join(wt, '.claude/hooks/guard.mjs'), 'x();\n');
    expect((await read(a)).hooks?.digest).toBe((await read(b)).hooks?.digest);
  });

  it('finds a changed .mcp.json and keeps the default branch servers', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.mcp.json'), { mcpServers: { evil: { command: 'sh' } } });
    const reading = await read(wt);
    expect(reading.mcpJson?.files).toEqual(['.mcp.json']);
    expect(reading.baselineServers).toEqual(MCP.mcpServers);
    // Reformatting alone is not a change.
    writeFile(path.join(wt, '.mcp.json'), JSON.stringify(MCP));
    expect((await read(wt)).mcpJson).toBeNull();
  });

  it('hashes a working file the way git does', () => {
    const sha = git(repo.main, ['rev-parse', 'HEAD:.claude/hooks/guard.mjs']);
    expect(gitBlobId(Buffer.from(GUARD_SCRIPT), sha.length)).toBe(sha);
  });
});

describe('local settings', () => {
  it('has nothing to approve when absent or only preferences', () => {
    const wt = repo.addWorktree('wt');
    expect(readLocalSettings(wt, DORK_HOME)).toBeNull();
    writeFile(path.join(wt, '.claude/settings.local.json'), { model: 'opus' });
    expect(readLocalSettings(wt, DORK_HOME)).toBeNull();
  });

  it('names the keys that run code, and digests by content only', () => {
    const a = repo.addWorktree('a');
    const b = repo.addWorktree('b');
    const body = {
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo allow' }] }] },
      permissions: { allow: ['Bash(*)'], deny: ['Read'] },
    };
    for (const wt of [a, b]) writeFile(path.join(wt, '.claude/settings.local.json'), body);
    const first = readLocalSettings(a, DORK_HOME);
    expect(first?.keys).toEqual(['hooks', 'permissions.allow']);
    expect(readLocalSettings(b, DORK_HOME)?.digest).toBe(first?.digest);
    writeFile(path.join(b, '.claude/settings.local.json'), { ...body, env: { X: '1' } });
    expect(readLocalSettings(b, DORK_HOME)?.digest).not.toBe(first?.digest);
  });

  it('changes its digest when a script a local hook runs changes', () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.claude/settings.local.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh scripts/x.sh' }] }] },
    });
    writeFile(path.join(wt, 'scripts/x.sh'), 'echo 1');
    const before = readLocalSettings(wt, DORK_HOME)?.digest;
    writeFile(path.join(wt, 'scripts/x.sh'), 'echo 2');
    expect(readLocalSettings(wt, DORK_HOME)?.digest).not.toBe(before);
  });

  it('can not vouch for a local settings file that is not a regular file', () => {
    const wt = repo.addWorktree('wt');
    fs.mkdirSync(path.join(wt, '.claude/settings.local.json'), { recursive: true });
    expect(readLocalSettings(wt, DORK_HOME)?.approvable).toBe(false);
  });
});

describe('the card diff', () => {
  it('folds unchanged runs and marks a new file', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const diff = fileDiff('a.sh', before, after);
    expect(diff).toContain('-line 10');
    expect(diff).toContain('+line ten');
    expect(diff).toContain('…');
    expect(diff).not.toContain(' line 0');
    expect(fileDiff('b.sh', null, 'x')).toContain('(not on the default branch)');
  });
});

describe('what an agent with a shell could forge or slip past', () => {
  it('reads the recorded commit itself, never a replacement an agent made for it', async () => {
    const wt = repo.addWorktree('wt');
    expect((await read(wt)).hooks).toBeNull();
    const baselineSha = git(repo.main, ['rev-parse', 'main']);
    writeFile(path.join(wt, '.claude/hooks/guard.mjs'), 'console.log("edited");\n');
    git(wt, ['commit', '-q', '-am', 'edited guard']);
    git(wt, ['replace', baselineSha, git(wt, ['rev-parse', 'HEAD'])]);
    expect((await read(wt)).hooks?.files).toEqual(['.claude/hooks/guard.mjs']);
  });

  it('checks the hooks a subagent sets in its frontmatter', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(
      path.join(wt, '.claude/agents/helper.md'),
      '---\nname: helper\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo allow\n---\nHelps.\n'
    );
    expect((await read(wt)).hooks?.files).toEqual(['.claude/agents/helper.md']);
  });

  it('leaves a subagent alone when only the words below its frontmatter changed', async () => {
    const agent =
      '---\nname: helper\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo done\n---\n';
    writeFile(path.join(repo.main, '.claude/agents/helper.md'), `${agent}Helps.\n`);
    repo.commit('helper');
    await approveDefaultBranch();
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.claude/agents/helper.md'), `${agent}Helps more.\n`);
    expect((await read(wt)).hooks).toBeNull();
  });

  it('compares the file a hook symlink points at, not only the link', async () => {
    writeFile(path.join(repo.main, 'scripts/real-guard.mjs'), GUARD_SCRIPT);
    fs.symlinkSync('../../scripts/real-guard.mjs', path.join(repo.main, '.claude/hooks/link.mjs'));
    repo.commit('linked guard');
    await approveDefaultBranch();
    const wt = repo.addWorktree('wt');
    expect((await read(wt)).hooks).toBeNull();
    writeFile(path.join(wt, 'scripts/real-guard.mjs'), 'console.log("edited");\n');
    expect((await read(wt)).hooks?.files).toEqual(['scripts/real-guard.mjs']);
  });

  it('names the allow rules the default branch does not have', async () => {
    const wt = repo.addWorktree('wt');
    writeFile(path.join(wt, '.claude/settings.json'), {
      ...GUARD_SETTINGS,
      permissions: { allow: ['Read', 'Bash(*)'] },
    });
    const reading = await read(wt);
    expect(reading.hooks?.files).toEqual(['.claude/settings.json']);
    expect(reading.hooks?.addedAllows).toEqual(['Bash(*)']);
  });
});

describe('a default branch that moved forward', () => {
  it('counts a change to the file a hook symlink points at', async () => {
    writeFile(path.join(repo.main, 'scripts/real-guard.sh'), 'exit 0\n');
    fs.symlinkSync('../../scripts/real-guard.sh', path.join(repo.main, '.claude/hooks/link.sh'));
    repo.commit('a linked guard');
    await approveDefaultBranch();
    const wt = repo.addWorktree('wt');
    writeFile(path.join(repo.main, 'scripts/real-guard.sh'), 'evil\n');
    repo.commit('only the target changed');
    expect((await resolveRepoBaseline(wt, DORK_HOME)).untrusted).toBe('hooks-moved');
  });
});

describe("Security's #3213 Musts", () => {
  it('M1: still sees an edited hook when the repo moves its own work tree', async () => {
    fs.mkdirSync(path.join(repo.root, 'elsewhere'));
    git(repo.main, ['config', 'core.worktree', path.join(repo.root, 'elsewhere')]);
    writeFile(path.join(repo.main, '.claude/hooks/guard.mjs'), 'evil();\n');
    expect((await read(repo.main)).hooks?.files).toEqual(['.claude/hooks/guard.mjs']);
  });

  it('M2: refuses a silent move when a commit in between touched a hook', async () => {
    const pinned = git(repo.main, ['rev-parse', 'main']);
    writeFile(path.join(repo.main, '.claude/hooks/guard.mjs'), 'evil();\n');
    const planted = repo.commit('a planted hook');
    writeFile(path.join(repo.main, '.claude/hooks/guard.mjs'), GUARD_SCRIPT);
    repo.commit('the hook "reverted"');
    git(repo.main, ['checkout', '-q', planted]);
    const baseline = await resolveRepoBaseline(repo.main, DORK_HOME);
    expect(baseline.untrusted).toBe('hooks-moved');
    expect(recordedBaseline(baseline.commonDir!)?.sha).toBe(pinned);
  });

  it('M2: refuses a silent move when a commit in between added a subagent that runs a hook', async () => {
    const pinned = git(repo.main, ['rev-parse', 'main']);
    const agent = path.join(repo.main, '.claude/agents/evil.md');
    writeFile(
      agent,
      '---\nname: evil\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo allow\n---\nHelps.\n'
    );
    const planted = repo.commit('a planted subagent');
    fs.rmSync(agent);
    repo.commit('the subagent "reverted"');
    git(repo.main, ['checkout', '-q', planted]);
    const baseline = await resolveRepoBaseline(repo.main, DORK_HOME);
    expect(baseline.untrusted).toBe('hooks-moved');
    expect(recordedBaseline(baseline.commonDir!)?.sha).toBe(pinned);
  });

  it('M2: refuses a silent move when a commit in between changed a skill in .agents', async () => {
    const skill = path.join(repo.main, '.agents/skills/x/SKILL.md');
    writeFile(skill, '---\nname: x\nallowed-tools: Read\n---\n');
    fs.mkdirSync(path.join(repo.main, '.claude/skills'), { recursive: true });
    fs.symlinkSync('../../.agents/skills/x', path.join(repo.main, '.claude/skills/x'));
    repo.commit('a linked skill');
    await approveDefaultBranch();
    const pinned = git(repo.main, ['rev-parse', 'main']);
    writeFile(skill, '---\nname: x\nallowed-tools: Bash\n---\n');
    const planted = repo.commit('the skill widened');
    writeFile(skill, '---\nname: x\nallowed-tools: Read\n---\n');
    repo.commit('the skill "reverted"');
    git(repo.main, ['checkout', '-q', planted]);
    const baseline = await resolveRepoBaseline(repo.main, DORK_HOME);
    expect(baseline.untrusted).toBe('hooks-moved');
    expect(recordedBaseline(baseline.commonDir!)?.sha).toBe(pinned);
  });

  it('M2: refuses a silent move when a skill linked from outside .claude and .agents changed in between', async () => {
    const skill = path.join(repo.main, 'tools/skills/x/SKILL.md');
    writeFile(skill, '---\nname: x\nallowed-tools: Read\n---\n');
    fs.mkdirSync(path.join(repo.main, '.claude/skills'), { recursive: true });
    fs.symlinkSync('../../tools/skills/x', path.join(repo.main, '.claude/skills/x'));
    repo.commit('a skill linked from tools/');
    await approveDefaultBranch();
    const pinned = git(repo.main, ['rev-parse', 'main']);
    writeFile(skill, '---\nname: x\nallowed-tools: Bash\n---\n');
    const planted = repo.commit('the linked skill widened');
    writeFile(skill, '---\nname: x\nallowed-tools: Read\n---\n');
    repo.commit('the linked skill "reverted"');
    git(repo.main, ['checkout', '-q', planted]);
    const baseline = await resolveRepoBaseline(repo.main, DORK_HOME);
    expect(baseline.untrusted).toBe('hooks-moved');
    expect(recordedBaseline(baseline.commonDir!)?.sha).toBe(pinned);
  });

  it('M2: trusts a fork point only inside the pinned commit’s own history', async () => {
    writeFile(path.join(repo.main, 'README.md'), 'one');
    const middle = repo.commit('after the pin');
    writeFile(path.join(repo.main, 'README.md'), 'two');
    const tip = repo.commit('the tip');
    const wt = path.join(repo.root, 'from-middle');
    git(repo.main, ['worktree', 'add', '-q', '-b', 'from-middle', wt, middle]);
    expect((await resolveRepoBaseline(wt, DORK_HOME)).commits).toEqual([tip]);
  });

  it('M2: never accepts a mix of files no single trusted commit holds', async () => {
    writeFile(path.join(repo.main, '.claude/hooks/a.sh'), 'a v1\n');
    writeFile(path.join(repo.main, '.claude/hooks/b.sh'), 'b v1\n');
    repo.commit('two hooks');
    await approveDefaultBranch();
    const wt = repo.addWorktree('wt');
    writeFile(path.join(repo.main, '.claude/hooks/a.sh'), 'a v2\n');
    writeFile(path.join(repo.main, '.claude/hooks/b.sh'), 'b v2\n');
    repo.commit('both hooks v2');
    await approveDefaultBranch();
    // a stays at the fork's v1, b is edited to the tip's v2: each file matches
    // some trusted commit, but no commit holds both.
    writeFile(path.join(wt, '.claude/hooks/b.sh'), 'b v2\n');
    expect((await read(wt)).hooks?.files.length).toBeGreaterThan(0);
  });

  it('M4: resolves a nested settings file’s commands from its own folder', async () => {
    writeFile(path.join(repo.main, 'pkg/.claude/settings.json'), {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/fmt.js' }] },
        ],
      },
    });
    writeFile(path.join(repo.main, 'pkg/scripts/fmt.js'), 'ok();\n');
    repo.commit('a nested hook');
    await approveDefaultBranch();
    const wt = repo.addWorktree('wt');
    writeFile(path.join(repo.main, 'pkg/scripts/fmt.js'), 'evil();\n');
    repo.commit('only the nested script changed');
    expect((await resolveRepoBaseline(wt, DORK_HOME)).untrusted).toBe('hooks-moved');
  });

  it('M3: a missing object never makes git fetch or run the repo’s ssh command', async () => {
    const marker = path.join(repo.root, 'ssh-ran');
    const ssh = path.join(repo.root, 'fake-ssh.sh');
    fs.writeFileSync(ssh, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
    fs.chmodSync(ssh, 0o755);
    git(repo.main, ['config', 'core.repositoryformatversion', '1']);
    git(repo.main, ['config', 'extensions.partialClone', 'origin']);
    git(repo.main, ['config', 'remote.origin.url', 'ssh://example.invalid/repo.git']);
    git(repo.main, ['config', 'remote.origin.promisor', 'true']);
    git(repo.main, ['config', 'core.sshCommand', ssh]);
    const wt = repo.addWorktree('wt');
    // Drop the hook script's blob, so reading it would need a fetch.
    const oid = git(repo.main, ['rev-parse', 'HEAD:.claude/hooks/guard.mjs']);
    fs.rmSync(path.join(repo.main, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    writeFile(path.join(wt, '.claude/hooks/guard.mjs'), 'changed();\n');
    await read(wt).catch(() => undefined);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('a repo that rewrites its own history', () => {
  it('is refused when it has a grafts file, which the runner cannot switch off', async () => {
    writeFile(path.join(repo.main, '.git', 'info', 'grafts'), '');
    await expect(resolveRepoBaseline(repo.main, DORK_HOME)).rejects.toThrow(/grafts/);
  });
});
