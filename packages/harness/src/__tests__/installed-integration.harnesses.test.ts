import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
  realpathSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../engine.js';
import { applyPlan } from '../apply/apply.js';
import { pluginRootText } from '../plan/installed-projector.js';
import { withoutEnvPrefix } from './installed-integration.fixtures.js';

let repo = '';

let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * A claude-code repo with one project-installed `flow`-shaped plugin: a skill, a
 * command referencing `${CLAUDE_PLUGIN_ROOT}`, and a Stop hook using the same
 * token (the exact shape that used to reach Claude only via SDK activation).
 */
function buildRepoWithClaudePlugin(): { repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-claude-int-'));
  mkdirSync(join(repoRoot, '.agents'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code'] }, null, 2)
  );

  const plugin = join(repoRoot, '.dork', 'plugins', 'flow');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'flow',
      version: '1.0.0',
      type: 'plugin',
      description: 'Flow test plugin',
      layers: ['commands', 'skills', 'hooks'],
    })
  );
  mkdirSync(join(plugin, 'commands'), { recursive: true });
  writeFileSync(
    join(plugin, 'commands', 'capture.md'),
    '---\ndescription: cap\n---\nRead `${CLAUDE_PLUGIN_ROOT}/skills/capturing/SKILL.md`.\n'
  );
  mkdirSync(join(plugin, 'skills', 'capturing'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 'capturing', 'SKILL.md'), '# capturing\n');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({
      Stop: [
        { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/loop.mjs"' }] },
      ],
    })
  );
  return { repoRoot };
}

describe('installed-plugin projection to the external Claude Code CLI', () => {
  it('AP-08: projects command wrappers, skill symlinks, and merged settings hooks, then sweeps them on uninstall', () => {
    repo = buildRepoWithClaudePlugin().repoRoot;
    const absInstall = join(repo, '.dork', 'plugins', 'flow');
    const wrapper = join(repo, '.claude', 'commands', 'flow', 'capture.md');
    const wrapperGitignore = join(repo, '.claude', 'commands', 'flow', '.gitignore');
    const skillLink = join(repo, '.claude', 'skills', 'flow__capturing');
    const settingsPath = join(repo, '.claude', 'settings.local.json');

    // A pre-existing user-owned settings.local.json with the user's own hook + key.
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-owned' }] }] },
      })
    );

    // Sync.
    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);

    // Command wrapper: token rewritten to the absolute install dir + engine marker.
    const wrapperContent = readFileSync(wrapper, 'utf8');
    expect(wrapperContent).toContain(
      `${pluginRootText(absInstall, process.platform)}/skills/capturing/SKILL.md`
    );
    expect(wrapperContent).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(wrapperContent).toContain('dorkos:generated-command');
    expect(readFileSync(wrapperGitignore, 'utf8')).toContain('*');

    // Skill symlink into the Claude Code skills dir.
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(skillLink)).toBe(realpathSync(join(absInstall, 'skills', 'capturing')));

    // settings.local.json: managed plugin hook merged in, user hook + key untouched.
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(merged.permissions).toEqual({ allow: ['Bash'] });
    const stopCommands = merged.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => withoutEnvPrefix(h.command))
    );
    expect(stopCommands).toContain('echo user-owned');
    expect(stopCommands).toContain(
      `node "${pluginRootText(absInstall, process.platform)}/hooks/loop.mjs"`
    );

    // Uninstall + re-sync with the sweep on.
    rmSync(join(repo, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    const plan2 = project(repo);
    const result2 = applyPlan(repo, plan2, { sweepOrphans: true });

    // Wrappers pruned (dir gone), skill symlink pruned, settings swept.
    expect(existsSync(join(repo, '.claude', 'commands', 'flow'))).toBe(false);
    expect(existsSync(skillLink)).toBe(false);
    expect(result2.swept).toContain('.claude/settings.local.json');

    // The user's own hook + key survive; only the managed group was removed.
    const afterSweep = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(afterSweep.permissions).toEqual({ allow: ['Bash'] });
    const afterStop = afterSweep.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => withoutEnvPrefix(h.command))
    );
    expect(afterStop).toEqual(['echo user-owned']);
  });
});

/**
 * A repo enabling claude-code + codex + opencode with one project-installed
 * `flow`-shaped plugin: a command with rich (Claude-specific) frontmatter and a
 * `${CLAUDE_PLUGIN_ROOT}` body reference, plus a skill.
 */
function buildRepoWithOpencodePlugin(): { repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-oc-int-'));
  mkdirSync(join(repoRoot, '.agents'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex', 'opencode'] }, null, 2)
  );

  const plugin = join(repoRoot, '.dork', 'plugins', 'flow');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'flow',
      version: '1.0.0',
      type: 'plugin',
      description: 'Flow test plugin',
      layers: ['commands', 'skills'],
    })
  );
  mkdirSync(join(plugin, 'commands'), { recursive: true });
  writeFileSync(
    join(plugin, 'commands', 'capture.md'),
    '---\n' +
      'description: Capture a thought (the /flow CAPTURE stage)\n' +
      'category: flow\n' +
      'allowed-tools: Read, Glob, Skill\n' +
      'argument-hint: "<idea>"\n' +
      '---\n' +
      'Read `${CLAUDE_PLUGIN_ROOT}/skills/capturing/SKILL.md`.\n'
  );
  mkdirSync(join(plugin, 'skills', 'capturing'), { recursive: true });
  writeFileSync(
    join(plugin, 'skills', 'capturing', 'SKILL.md'),
    '---\nname: capturing\n---\n# cap\n'
  );
  return { repoRoot };
}

describe('installed-plugin projection to the OpenCode harness', () => {
  it('CM-03: projects a flat wrapper with rewritten path + stripped frontmatter, aggregates the safe gitignore, leaves an authored command untouched, then sweeps on uninstall', () => {
    repo = buildRepoWithOpencodePlugin().repoRoot;
    const absInstall = join(repo, '.dork', 'plugins', 'flow');
    const wrapper = join(repo, '.opencode', 'commands', 'flow-capture.md');
    const gitignore = join(repo, '.opencode', 'commands', '.gitignore');
    const authored = join(repo, '.opencode', 'commands', 'mine.md');

    // A pre-existing authored OpenCode command sharing the flat dir.
    mkdirSync(join(repo, '.opencode', 'commands'), { recursive: true });
    writeFileSync(authored, '# my own command\n');

    // Sync.
    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);

    // Wrapper: flat name `flow-capture.md`, invoked `/flow-capture`.
    const wrapperContent = readFileSync(wrapper, 'utf8');
    // Token rewritten to the absolute install dir.
    expect(wrapperContent).toContain(
      `${pluginRootText(absInstall, process.platform)}/skills/capturing/SKILL.md`
    );
    expect(wrapperContent).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    // Frontmatter reduced to ONLY description; Claude-only keys stripped.
    expect(
      wrapperContent.startsWith(
        '---\ndescription: Capture a thought (the /flow CAPTURE stage)\n---\n'
      )
    ).toBe(true);
    expect(wrapperContent).not.toContain('allowed-tools');
    expect(wrapperContent).not.toContain('argument-hint');
    expect(wrapperContent).toContain('dorkos:generated-command');

    // Aggregated gitignore: names the engine wrapper + itself, NEVER `*`, and does
    // NOT list the authored command (which stays committable).
    const gitignoreContent = readFileSync(gitignore, 'utf8');
    expect(gitignoreContent).toContain('flow-capture.md');
    expect(gitignoreContent).toContain('.gitignore');
    expect(gitignoreContent).not.toContain('*');
    expect(gitignoreContent).not.toContain('mine.md');

    // The authored command is untouched (never ignored, never deleted).
    expect(readFileSync(authored, 'utf8')).toBe('# my own command\n');

    // Uninstall + re-sync with the sweep on: the wrapper + gitignore are pruned,
    // the authored command survives.
    rmSync(join(repo, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    const plan2 = project(repo);
    const result2 = applyPlan(repo, plan2, { sweepOrphans: true });

    expect(result2.swept).toContain('.opencode/commands/flow-capture.md');
    expect(result2.swept).toContain('.opencode/commands/.gitignore');
    expect(existsSync(wrapper)).toBe(false);
    expect(existsSync(gitignore)).toBe(false);
    expect(readFileSync(authored, 'utf8')).toBe('# my own command\n');
  });

  it('CM-02: surfaces a conflict (never overwrites) when an authored command file already occupies a wrapper target', () => {
    repo = buildRepoWithOpencodePlugin().repoRoot;
    const wrapper = join(repo, '.opencode', 'commands', 'flow-capture.md');

    // The user already authored a command at the exact wrapper path.
    mkdirSync(join(repo, '.opencode', 'commands'), { recursive: true });
    writeFileSync(wrapper, '# hand-authored, do not clobber\n');

    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });

    // The wrapper generate is a conflict; the authored file is left intact.
    expect(result.conflicts.some((a) => a.target === '.opencode/commands/flow-capture.md')).toBe(
      true
    );
    expect(readFileSync(wrapper, 'utf8')).toBe('# hand-authored, do not clobber\n');
  });
});
