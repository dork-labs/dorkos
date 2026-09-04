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
import { getActionContent } from '../plan/content-map.js';
import type { ProjectionPlan } from '../plan/types.js';

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

  it('projects a CC-NATIVE plugin (only .claude-plugin/plugin.json, no .dork/manifest.json) — DOR-264', () => {
    // The marketplace installer copies Claude Code packages verbatim, so a
    // CC-native install never gains a `.dork/manifest.json`. Before the CC
    // fallback in `readPluginManifest`, the scanner skipped these entirely and
    // Harness Sync auto-projection silently applied ZERO files for every
    // project-scoped install of a real CC plugin.
    repo = mkdtempSync(join(tmpdir(), 'harness-cc-native-'));
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
    );

    // Mirrors anthropics/claude-plugins-public layout: CC manifest + commands + skills.
    const plugin = join(repo, '.dork', 'plugins', 'commit-commands');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'commit-commands', version: '1.0.0', description: 'CC native' })
    );
    mkdirSync(join(plugin, 'commands'), { recursive: true });
    writeFileSync(join(plugin, 'commands', 'commit.md'), '# /commit\nCommit the work.\n');
    mkdirSync(join(plugin, 'skills', 'committing'), { recursive: true });
    writeFileSync(
      join(plugin, 'skills', 'committing', 'SKILL.md'),
      '---\nname: committing\ndescription: commit helper\n---\nBody\n'
    );

    const plan = project(repo);

    // The plugin's assets are IN the plan — the exact opposite of the bug.
    const sources = [...plan.actions, ...plan.drops].map((a) => a.source ?? '');
    expect(sources.some((s) => s.startsWith('.dork/plugins/commit-commands/'))).toBe(true);

    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);
    expect(result.applied.length).toBeGreaterThan(0);

    // Skill symlinked into the Codex skills dir, namespaced by package.
    const projectedSkill = join(repo, '.agents', 'skills', 'commit-commands__committing');
    expect(lstatSync(projectedSkill).isSymbolicLink()).toBe(true);
    // Command wrapper generated for the external Claude Code CLI.
    expect(existsSync(join(repo, '.claude', 'commands', 'commit-commands', 'commit.md'))).toBe(
      true
    );
  });

  it('skips a CC-native plugin whose plugin.json name is not a valid slug (no crash, no projection)', () => {
    // `dorkos harness sync` scans `.dork/plugins/` independently of install-time
    // validation, and the plugin name is interpolated into projector paths — an
    // arbitrary string (path traversal, spaces, uppercase) must never get through.
    repo = mkdtempSync(join(tmpdir(), 'harness-cc-badname-'));
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
    );

    const plugin = join(repo, '.dork', 'plugins', 'evil');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: '../escape zone', version: '1.0.0' })
    );
    mkdirSync(join(plugin, 'skills', 'sneaky'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'sneaky', 'SKILL.md'), '# sneaky\n');

    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });

    // The plugin is skipped entirely: nothing planned or applied from it.
    const sources = [...plan.actions, ...plan.drops].map((a) => a.source ?? '');
    expect(sources.some((s) => s.includes('.dork/plugins/evil'))).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(repo, '.agents', 'skills'))).toBe(false);
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

  it('links a plugin’s scheduled skill into `.agents/skills` on a claude-code-only project, and sweeps it on uninstall (DOR-1518)', () => {
    // The shape that made the flow plugin's schedules undiscoverable: a stock
    // project enables `claude-code` alone, so the plugin's scheduled skill only
    // ever reached `.claude/skills`, which the scheduler does not watch.
    repo = mkdtempSync(join(tmpdir(), 'harness-sched-int-'));
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code'] }, null, 2)
    );

    const plugin = join(repo, '.dork', 'plugins', 'flow');
    mkdirSync(join(plugin, '.dork'), { recursive: true });
    writeFileSync(
      join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'flow',
        version: '1.0.0',
        type: 'plugin',
        description: 'Flow test plugin',
        layers: ['skills'],
      })
    );
    mkdirSync(join(plugin, 'skills', 'drain'), { recursive: true });
    writeFileSync(
      join(plugin, 'skills', 'drain', 'SKILL.md'),
      "---\nname: drain\ndescription: Drains the queue\nschedule:\n  cron: '0 9 * * *'\n---\nDrain it.\n"
    );
    mkdirSync(join(plugin, 'skills', 'grooming'), { recursive: true });
    writeFileSync(
      join(plugin, 'skills', 'grooming', 'SKILL.md'),
      '---\nname: grooming\ndescription: Grooms\n---\nGroom it.\n'
    );

    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);

    // The scheduled skill is on disk in the watched root, under the NAMESPACED
    // link name the discovery layer expects, resolving to the plugin's own dir.
    const link = join(repo, '.agents', 'skills', 'flow__drain');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(plugin, 'skills', 'drain')));
    expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toContain('name: drain');

    // The unscheduled sibling is not dragged along — it has no business there.
    expect(existsSync(join(repo, '.agents', 'skills', 'flow__grooming'))).toBe(false);
    // Both still reach Claude Code, exactly as before.
    expect(existsSync(join(repo, '.claude', 'skills', 'flow__drain'))).toBe(true);
    expect(existsSync(join(repo, '.claude', 'skills', 'flow__grooming'))).toBe(true);

    // Uninstall: the link is an ordinary managed projection, so the existing
    // orphan sweep removes it with no special casing.
    rmSync(plugin, { recursive: true, force: true });
    const plan2 = project(repo);
    const result2 = applyPlan(repo, plan2, { sweepOrphans: true });
    expect(result2.swept).toContain('.agents/skills/flow__drain');
    expect(existsSync(link)).toBe(false);
  });

  it('warns, naming the file and the events, when a rotted hooks.json is salvaged (DOR-1724)', () => {
    // The post-install rot the pre-install preview cannot see: the package
    // installed fine, then its `hooks/hooks.json` was hand-edited into a shape the
    // reader can only partly use. `Stop` keeps one group and loses another;
    // `PostToolUse` loses everything; `Notification` is not even an array.
    const built = buildRepoWithPluginHook();
    repo = built.repoRoot;
    dorkHome = built.home;
    const hooksFile = join(repo, '.dork', 'plugins', 'flow', 'hooks', 'hooks.json');
    writeFileSync(
      hooksFile,
      JSON.stringify({
        Stop: [{ hooks: [{ command: 'good.sh' }] }, { hooks: 'nope' }],
        PostToolUse: [{ hooks: [{ type: 'command' }] }],
        Notification: { command: 'not-an-array.sh' },
      })
    );

    const plan = project(repo, { dorkHome });

    // The readable half still projects — the salvage is not undone by disclosing it.
    expect(
      JSON.parse(getActionContent(plan.actions.find((a) => a.name === 'plugin-hooks')!)!)
    ).toHaveProperty('Stop');

    const hookWarnings = plan.warnings.filter((w) => w.artifact === 'hook');
    expect(hookWarnings.map((w) => w.name).sort()).toEqual([
      'flow:Notification',
      'flow:PostToolUse',
      'flow:Stop',
    ]);
    // Every reason names the FILE and the EVENT, and says whether anything survived.
    for (const warning of hookWarnings) {
      expect(warning.reason).toContain('.dork/plugins/flow/hooks/hooks.json');
    }
    expect(hookWarnings.find((w) => w.name === 'flow:Stop')!.reason).toContain(
      'only the readable ones are projected'
    );
    expect(hookWarnings.find((w) => w.name === 'flow:PostToolUse')!.reason).toContain(
      'no "PostToolUse" hook is projected'
    );
    expect(hookWarnings.find((w) => w.name === 'flow:Notification')!.reason).toContain(
      'no "Notification" hook is projected'
    );
  });

  it('warns once, naming the whole file, when a hooks.json is not valid JSON at all (DOR-1724)', () => {
    const built = buildRepoWithPluginHook();
    repo = built.repoRoot;
    dorkHome = built.home;
    writeFileSync(join(repo, '.dork', 'plugins', 'flow', 'hooks', 'hooks.json'), '{ truncated');

    const plan = project(repo, { dorkHome });

    expect(plan.warnings.filter((w) => w.artifact === 'hook')).toEqual([
      {
        artifact: 'hook',
        harness: 'claude-code',
        name: 'flow:hooks',
        reason:
          '.dork/plugins/flow/hooks/hooks.json could not be read (invalid JSON, or a top level that is not an object), so every hook this package declares was dropped and none are projected',
      },
    ]);
  });

  it('warns nothing when every installed hooks.json is fully readable (DOR-1724)', () => {
    const built = buildRepoWithPluginHook();
    repo = built.repoRoot;
    dorkHome = built.home;

    expect(project(repo, { dorkHome }).warnings.filter((w) => w.artifact === 'hook')).toEqual([]);
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

/**
 * A repo enabling claude-code + codex with two project-installed plugins: one
 * whose `hooks/hooks.json` is written from `hostileHooks`, and one whose hooks
 * are clean. The clean plugin is the containment probe — a malformed file in one
 * package must never cost another package its hooks.
 */
function buildRepoWithTwoHookPlugins(hostileHooks: unknown): {
  repoRoot: string;
  hostileHooksPath: string;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-bad-hooks-'));
  mkdirSync(join(repoRoot, '.agents'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
  );

  for (const name of ['hostile', 'clean']) {
    const plugin = join(repoRoot, '.dork', 'plugins', name);
    mkdirSync(join(plugin, '.dork'), { recursive: true });
    writeFileSync(
      join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name,
        version: '1.0.0',
        type: 'plugin',
        description: `${name} test plugin`,
        layers: ['hooks'],
      })
    );
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
  }

  const hostileHooksPath = join(repoRoot, '.dork', 'plugins', 'hostile', 'hooks', 'hooks.json');
  writeFileSync(hostileHooksPath, JSON.stringify(hostileHooks));
  writeFileSync(
    join(repoRoot, '.dork', 'plugins', 'clean', 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'clean.sh' }] }] })
  );

  return { repoRoot, hostileHooksPath };
}

/** Every hook command the plan would merge into `.claude/settings.local.json`. */
function mergedSettingsCommands(plan: ProjectionPlan): string[] {
  const merge = plan.actions.find((a) => a.target === '.claude/settings.local.json');
  const content = merge ? getActionContent(merge) : undefined;
  if (!content) return [];
  const hooks = JSON.parse(content) as Record<string, { hooks?: { command: string }[] }[]>;
  return Object.values(hooks).flatMap((groups) =>
    groups.flatMap((group) => (group.hooks ?? []).map((h) => h.command))
  );
}

describe('installed-plugin projection — a malformed hooks.json cannot take the projection down (DOR-646)', () => {
  it('drops the unusable groups, keeps their readable siblings, and leaves other packages intact', () => {
    // All four shapes the PR #552 differential sweep found, in one file, beside a
    // readable group. Before this fix `project()` threw `TypeError:
    // group.hooks.map is not a function` and NOTHING projected — not the sibling
    // command, not the other package, not the skills or commands of either.
    const built = buildRepoWithTwoHookPlugins({
      Stop: [{ hooks: [{ command: 'good.sh' }] }, { hooks: 'nope' }],
      PreToolUse: [{ hooks: [{ type: 'command' }] }, { hooks: [{ command: 42 }] }, null],
    });
    repo = built.repoRoot;

    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);

    // The readable sibling survives, in the settings merge and the generated
    // Codex hooks file alike; the unreadable event contributes nothing.
    const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
    const stopCommands = settings.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command)
    );
    expect(stopCommands).toEqual(expect.arrayContaining(['good.sh', 'clean.sh']));
    expect(settings.hooks.PreToolUse).toBeUndefined();

    const codexHooks = readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8');
    expect(codexHooks).toContain('good.sh');
    expect(codexHooks).toContain('clean.sh');
  });

  // The sweep derives its field list from a WELL-FORMED document at runtime, so a
  // field added to the hook shape later is covered without anyone remembering to
  // extend this test — the argument DOR-535 settled one nesting level up.
  //
  // Its reach is deliberately bounded: it mutates VALUES at existing paths, never
  // KEY NAMES. A hostile key (`__proto__` as an event name, which the sweep would
  // never generate) is a different class and belongs to the adversarial-document
  // cases below, which now cover it.
  describe('non-conformance sweep over every field of a well-formed hooks.json', () => {
    const CANONICAL_HOOKS = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 30 }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }],
      },
    };

    /** Values a hostile or sloppy package can put anywhere in a JSON document. */
    const HOSTILE_VALUES = [null, 42, 'nope', true, [], {}] as const;

    /** Every addressable location in a JSON document — each object key and array index. */
    function jsonPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
      if (value === null || typeof value !== 'object') return [];
      const entries: [string | number, unknown][] = Array.isArray(value)
        ? value.map((child, index) => [index, child])
        : Object.entries(value);
      return entries.flatMap(([key, child]) => [
        [...prefix, key],
        ...jsonPaths(child, [...prefix, key]),
      ]);
    }

    /** A clone of `doc` with `path` set to `value`, or deleted when `value` is `DELETE`. */
    const DELETE = Symbol('delete');
    function mutate(doc: unknown, path: (string | number)[], value: unknown): unknown {
      const clone = structuredClone(doc) as Record<string | number, unknown>;
      let parent = clone;
      for (const key of path.slice(0, -1)) parent = parent[key] as typeof parent;
      const leaf = path[path.length - 1]!;
      if (value === DELETE) {
        if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
        else delete parent[leaf];
      } else {
        parent[leaf] = value;
      }
      return clone;
    }

    const paths = jsonPaths(CANONICAL_HOOKS);

    it('addresses every nesting level of the canonical document', () => {
      // Guards the sweep itself: a path walker that silently stopped at the top
      // level would make every case below vacuous.
      expect(paths.length).toBeGreaterThan(10);
      expect(paths).toContainEqual(['hooks', 'PreToolUse', 0, 'hooks', 0, 'command']);
    });

    it.each(paths.map((path) => [path.join('.'), path] as const))(
      'survives every hostile value at %s',
      (_label, path) => {
        const built = buildRepoWithTwoHookPlugins(CANONICAL_HOOKS);
        repo = built.repoRoot;

        for (const value of [...HOSTILE_VALUES, DELETE]) {
          writeFileSync(
            built.hostileHooksPath,
            JSON.stringify(mutate(CANONICAL_HOOKS, path, value))
          );
          const plan = project(repo);
          // Containment: the other package's hook is planned whatever the
          // hostile package's file says.
          expect(mergedSettingsCommands(plan)).toContain('clean.sh');
        }
      }
    );
  });

  describe('adversarial documents the value sweep cannot generate', () => {
    it('projects an event a package named `__proto__`, and pollutes nothing', () => {
      // Assigning a `__proto__` key to a `{}` accumulator hits the inherited
      // setter: the groups vanish with no error and the accumulator's prototype
      // is replaced. Every hop from the reader to the settings merge therefore
      // accumulates onto a null-prototype object. A computed key is used here
      // because the literal `__proto__:` syntax would set the fixture's
      // prototype instead of giving it the property a package's JSON has.
      const built = buildRepoWithTwoHookPlugins({
        Stop: [{ hooks: [{ type: 'command', command: 'real.sh' }] }],
        ['__proto__' as string]: [{ hooks: [{ type: 'command', command: 'sneaky.sh' }] }],
      });
      repo = built.repoRoot;

      const plan = project(repo);
      const commands = mergedSettingsCommands(plan);
      expect(commands).toContain('real.sh');
      expect(commands).toContain('clean.sh');
      // Disclosed by the preview, so projected here too — as an event no harness
      // maps, never as a silently swallowed one.
      expect(commands).toContain('sneaky.sh');

      // Nothing leaked onto the prototype chain, in this process or the file.
      expect(({} as Record<string, unknown>).Stop).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);

      const result = applyPlan(repo, plan, { sweepOrphans: true });
      expect(result.conflicts).toEqual([]);
      const settingsRaw = readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8');
      expect(settingsRaw).toContain('sneaky.sh');
      expect(JSON.parse(settingsRaw).hooks.Stop).toBeDefined();
    });
  });
});
