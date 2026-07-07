import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
  realpathSync,
  existsSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../engine.js';
import { applyPlan, sweepInstalledOrphans, sweepGeneratedOrphans } from '../apply/apply.js';

let repo = '';
let dorkHome = '';
afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** A repo that enables claude-code + codex and has one project-installed plugin with a skill. */
function buildRepoWithInstalledPlugin(): { repoRoot: string; home: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-inst-int-'));
  const home = mkdtempSync(join(tmpdir(), 'harness-inst-home-'));

  mkdirSync(join(repoRoot, '.agents'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
  );

  const plugin = join(repoRoot, '.dork', 'plugins', 'acme');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'Acme test plugin',
      layers: ['skills'],
    })
  );
  mkdirSync(join(plugin, 'skills', 'greet'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 'greet', 'SKILL.md'), '# greet\n');

  return { repoRoot, home };
}

/**
 * A repo enabling claude-code + codex with one project-installed plugin whose
 * ONLY hook is a Stop hook using ${CLAUDE_PLUGIN_ROOT} (the flow plugin's shape),
 * and NO authored `.claude/settings.json` hooks. Uninstalling the plugin thus
 * removes the only source that generates `.codex/hooks.json`.
 */
function buildRepoWithPluginHook(): { repoRoot: string; home: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-hook-int-'));
  const home = mkdtempSync(join(tmpdir(), 'harness-hook-home-'));

  mkdirSync(join(repoRoot, '.agents'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
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
      layers: ['hooks'],
    })
  );
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'cd "$(git rev-parse --show-toplevel)" && node "${CLAUDE_PLUGIN_ROOT}/hooks/flow-loop.mjs"',
            },
          ],
        },
      ],
    })
  );

  return { repoRoot, home };
}

describe('installed-plugin projection — real install/sync/uninstall scenario', () => {
  it('projects an installed skill into the Codex dir, then sweeps it on uninstall', () => {
    const built = buildRepoWithInstalledPlugin();
    repo = built.repoRoot;
    dorkHome = built.home;

    // Sync: the installed plugin's skill lands as a namespaced symlink in the Codex dir.
    const plan = project(repo, { dorkHome });
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);

    const projected = join(repo, '.agents', 'skills', 'acme__greet');
    expect(lstatSync(projected).isSymbolicLink()).toBe(true);
    expect(realpathSync(projected)).toBe(
      realpathSync(join(repo, '.dork', 'plugins', 'acme', 'skills', 'greet'))
    );

    // Uninstall the plugin, then re-sync: the orphaned projection is swept.
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });
    const plan2 = project(repo, { dorkHome });
    const result2 = applyPlan(repo, plan2, { sweepOrphans: true });

    expect(result2.swept).toContain('.agents/skills/acme__greet');
    expect(existsSync(projected)).toBe(false);
  });

  it('projects a project-scoped installed plugin with NO dorkHome (offline `dorkos harness sync`)', () => {
    // Regression for the wiring bug where `project()` gated ALL installed-plugin
    // scanning behind `opts.dorkHome`: an offline CLI run (no ~/.dork, so
    // DORK_HOME unset) projected zero installed assets. Project-scoped installs
    // are repo-relative and must project with no dork home.
    const built = buildRepoWithInstalledPlugin();
    repo = built.repoRoot;
    dorkHome = built.home;

    // No `dorkHome` passed — mirrors `project(repoRoot)` with DORK_HOME unset.
    const plan = project(repo);

    // The installed skill is in the plan (not zero) and symlinks into both the
    // Codex and Claude Code skill dirs (namespaced).
    const targets = plan.actions
      .filter((a) => a.kind === 'symlink' && a.name === 'acme__greet')
      .map((a) => a.target);
    expect(targets).toContain('.agents/skills/acme__greet');
    expect(targets).toContain('.claude/skills/acme__greet');

    // And `--fix` realizes it on disk with no conflicts.
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);
    const projected = join(repo, '.agents', 'skills', 'acme__greet');
    expect(lstatSync(projected).isSymbolicLink()).toBe(true);
    expect(realpathSync(projected)).toBe(
      realpathSync(join(repo, '.dork', 'plugins', 'acme', 'skills', 'greet'))
    );
  });

  it('never sweeps a hand-authored `__` directory — only managed symlinks', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inst-int-'));
    const skillsDir = join(repo, '.agents', 'skills');

    // A hand-authored skill whose name happens to contain `__` (a real directory).
    mkdirSync(join(skillsDir, 'my__helper'), { recursive: true });
    writeFileSync(join(skillsDir, 'my__helper', 'SKILL.md'), '# precious, do not delete\n');

    // An orphaned managed projection (a symlink) from an uninstalled plugin.
    const orphan = join(skillsDir, 'gone__skill');
    symlinkSync('../../.dork/plugins/gone/skills/skill', orphan);

    // Sweep with an empty plan: nothing is "managed", so every candidate is an orphan.
    const swept = sweepInstalledOrphans(repo, { actions: [], drops: [], warnings: [] });

    // The symlink is swept; the hand-authored real directory is untouched.
    expect(swept).toEqual(['.agents/skills/gone__skill']);
    expect(existsSync(orphan)).toBe(false);
    expect(lstatSync(join(skillsDir, 'my__helper')).isDirectory()).toBe(true);
    expect(readFileSync(join(skillsDir, 'my__helper', 'SKILL.md'), 'utf8')).toBe(
      '# precious, do not delete\n'
    );
  });

  it('generates `.codex/hooks.json` from a plugin hook with the token REWRITTEN to absolute (no warning), then prunes it on uninstall (GAP-8 + item A)', () => {
    const built = buildRepoWithPluginHook();
    repo = built.repoRoot;
    dorkHome = built.home;
    const hooksPath = join(repo, '.codex', 'hooks.json');
    const absInstall = join(repo, '.dork', 'plugins', 'flow');

    // Sync: the plugin's Stop hook generates `.codex/hooks.json`…
    const plan = project(repo, { dorkHome });
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);
    expect(existsSync(hooksPath)).toBe(true);
    const hooksFile = readFileSync(hooksPath, 'utf8');
    expect(JSON.parse(hooksFile)).toHaveProperty('Stop');

    // …with `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute install dir (item A):
    // the install root is known at plan time, so the folded plugin hook is portable
    // in Codex, not projected-but-broken.
    expect(hooksFile).toContain(join(absInstall, 'hooks/flow-loop.mjs'));
    expect(hooksFile).not.toContain('${CLAUDE_PLUGIN_ROOT}');

    // …and there is NO Claude-only-token warning for the installed hook (only
    // authored/unresolved tokens warn now).
    expect(plan.warnings.some((w) => w.harness === 'codex' && w.artifact === 'hook')).toBe(false);

    // Uninstall the plugin (its hook was the only hook source), then re-sync.
    rmSync(join(repo, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    const plan2 = project(repo, { dorkHome });

    // No generate action remains for the hooks file…
    expect(
      plan2.actions.some((a) => a.kind === 'generate' && a.target === '.codex/hooks.json')
    ).toBe(false);

    // …and apply prunes the orphaned generated file (the GAP-8 fix).
    const result2 = applyPlan(repo, plan2, { sweepOrphans: true });
    expect(result2.swept).toContain('.codex/hooks.json');
    expect(existsSync(hooksPath)).toBe(false);
  });

  it('keeps a still-generated `.codex/hooks.json` and never prunes an unowned file', () => {
    const built = buildRepoWithPluginHook();
    repo = built.repoRoot;
    dorkHome = built.home;
    const hooksPath = join(repo, '.codex', 'hooks.json');

    // Plan still generates the file → it is kept, not pruned.
    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan, { sweepOrphans: true });
    expect(existsSync(hooksPath)).toBe(true);

    const swept = sweepGeneratedOrphans(repo, plan);
    expect(swept).toEqual([]);
    expect(existsSync(hooksPath)).toBe(true);
  });

  it('generates cursor + copilot hook files from an authored hook, then prunes each on uninstall (FND-6 + GAP-8)', () => {
    // A repo enabling cursor + copilot with an authored `.claude/settings.json`
    // Stop hook: both standalone generated files are produced and applied…
    repo = mkdtempSync(join(tmpdir(), 'harness-multi-hook-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-multi-home-'));
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'cursor', 'copilot'] }, null, 2)
    );
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } })
    );

    const cursorPath = join(repo, '.cursor', 'hooks.json');
    const copilotPath = join(repo, '.github', 'hooks', 'copilot-hooks.json');

    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan, { sweepOrphans: true });
    expect(JSON.parse(readFileSync(cursorPath, 'utf8')).hooks).toHaveProperty('stop');
    expect(JSON.parse(readFileSync(copilotPath, 'utf8')).hooks).toHaveProperty('agentStop');

    // …and once the source hook is gone, the standalone files are pruned as orphans
    // (both `.cursor/hooks.json` and `.github/hooks/copilot-hooks.json` are engine-owned).
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    const plan2 = project(repo, { dorkHome });
    const swept = sweepGeneratedOrphans(repo, plan2);
    expect(swept).toContain('.cursor/hooks.json');
    expect(swept).toContain('.github/hooks/copilot-hooks.json');
    expect(existsSync(cursorPath)).toBe(false);
    expect(existsSync(copilotPath)).toBe(false);
  });
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
  it('projects command wrappers, skill symlinks, and merged settings hooks, then sweeps them on uninstall', () => {
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
    expect(wrapperContent).toContain(join(absInstall, 'skills/capturing/SKILL.md'));
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
      g.hooks.map((h) => h.command)
    );
    expect(stopCommands).toContain('echo user-owned');
    expect(stopCommands).toContain(`node "${join(absInstall, 'hooks/loop.mjs')}"`);

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
      g.hooks.map((h) => h.command)
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
  it('projects a flat wrapper with rewritten path + stripped frontmatter, aggregates the safe gitignore, leaves an authored command untouched, then sweeps on uninstall', () => {
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
    expect(wrapperContent).toContain(join(absInstall, 'skills/capturing/SKILL.md'));
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

  it('surfaces a conflict (never overwrites) when an authored command file already occupies a wrapper target', () => {
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
