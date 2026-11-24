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
import { applyPlan, sweepInstalledOrphans } from '../apply/apply.js';
import { sweepGeneratedOrphans } from '../apply/generated-targets.js';
import { pluginRootText } from '../plan/installed-projector.js';
import { getActionContent } from '../plan/content-map.js';

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
  it('SK-02, AP-08: projects an installed skill into the Codex dir, then sweeps it on uninstall', () => {
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

  it('SRC-03: projects a CC-NATIVE plugin (only .claude-plugin/plugin.json, no .dork/manifest.json) — DOR-264', () => {
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

  it('SK-03: links a plugin’s skills into `.agents/skills` on a claude-code-only project, and sweeps them on uninstall (DOR-1518, DOR-1847)', () => {
    // The shape that made the flow plugin's schedules undiscoverable: a stock
    // project enables `claude-code` alone, so the plugin's scheduled skill only
    // ever reached `.claude/skills`, which the scheduler does not watch. DOR-1847
    // widened the link from the scheduled skill to every one of them, for the
    // same reason one directory over: `.agents/skills` is also what Codex,
    // OpenCode, Cursor, Gemini CLI and Copilot read.
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

    // The unscheduled sibling is linked there too now, and resolves the same way.
    const sibling = join(repo, '.agents', 'skills', 'flow__grooming');
    expect(lstatSync(sibling).isSymbolicLink()).toBe(true);
    expect(realpathSync(sibling)).toBe(realpathSync(join(plugin, 'skills', 'grooming')));
    // Both still reach Claude Code, exactly as before.
    expect(existsSync(join(repo, '.claude', 'skills', 'flow__drain'))).toBe(true);
    expect(existsSync(join(repo, '.claude', 'skills', 'flow__grooming'))).toBe(true);

    // Uninstall: each link is an ordinary managed projection, so the existing
    // orphan sweep removes them with no special casing.
    rmSync(plugin, { recursive: true, force: true });
    const plan2 = project(repo);
    const result2 = applyPlan(repo, plan2, { sweepOrphans: true });
    expect(result2.swept).toContain('.agents/skills/flow__drain');
    expect(result2.swept).toContain('.agents/skills/flow__grooming');
    expect(existsSync(link)).toBe(false);
    expect(existsSync(sibling)).toBe(false);
  });

  it('HK-09: warns, naming the file and the events, when a rotted hooks.json is salvaged (DOR-1724)', () => {
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

  it('AP-07: keeps an AUTHORED skill link whose name contains `__`, in the same apply that made it', () => {
    // The sweep may only TOUCH a `__`-named symlink — but what it KEEPS used to
    // be the installed-plugin links alone. An authored skill whose own name
    // contains `__` projects as an authored symlink at exactly such a path, so
    // one `applyPlan(..., { sweepOrphans: true })` created the link and then
    // deleted it again on the way out (found by DOR-1844, which makes the
    // scanner see those directories in the first place).
    repo = mkdtempSync(join(tmpdir(), 'harness-authored-ns-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-authored-ns-home-'));
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
    );
    const source = join(repo, '.agents', 'skills', 'my__helper');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# my__helper\n');

    // The real scanner, the real projector, the real sweep: since DOR-1844 the
    // scan keeps a real `__` DIRECTORY, so the plan carries an authored symlink
    // at a path that looks managed — which is exactly the pair that used to
    // cancel itself out inside one call.
    const plan = project(repo, { dorkHome });
    const { applied, swept } = applyPlan(repo, plan, { sweepOrphans: true });

    expect(applied.some((a) => a.target === '.claude/skills/my__helper')).toBe(true);
    expect(swept).toEqual([]);
    const link = join(repo, '.claude', 'skills', 'my__helper');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(source));
  });

  it('AP-07: never sweeps a hand-authored `__` directory — only managed symlinks', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-inst-int-'));
    const skillsDir = join(repo, '.agents', 'skills');

    // A hand-authored skill whose name happens to contain `__` (a real directory).
    mkdirSync(join(skillsDir, 'my__helper'), { recursive: true });
    writeFileSync(join(skillsDir, 'my__helper', 'SKILL.md'), '# precious, do not delete\n');

    // An orphaned managed projection (a symlink) from an uninstalled plugin.
    const orphan = join(skillsDir, 'gone__skill');
    symlinkSync('../../.dork/plugins/gone/skills/skill', orphan);

    // Sweep with an empty plan: nothing is "managed", so every candidate is an orphan.
    const swept = sweepInstalledOrphans(repo, {
      actions: [],
      drops: [],
      warnings: [],
      notEnabled: [],
    });

    // The symlink is swept; the hand-authored real directory is untouched.
    expect(swept).toEqual(['.agents/skills/gone__skill']);
    expect(existsSync(orphan)).toBe(false);
    expect(lstatSync(join(skillsDir, 'my__helper')).isDirectory()).toBe(true);
    expect(readFileSync(join(skillsDir, 'my__helper', 'SKILL.md'), 'utf8')).toBe(
      '# precious, do not delete\n'
    );
  });

  it('HK-05, AP-08: generates `.codex/hooks.json` from a plugin hook with the token REWRITTEN to absolute (no warning), then prunes it on uninstall (GAP-8 + item A)', () => {
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
    expect(JSON.parse(hooksFile).hooks).toHaveProperty('Stop');

    // …with `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute install dir (item A):
    // the install root is known at plan time, so the folded plugin hook is portable
    // in Codex, not projected-but-broken.
    expect(hooksFile).toContain(
      `${pluginRootText(absInstall, process.platform)}/hooks/flow-loop.mjs`
    );
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

    // …and apply prunes the orphaned generated file — with the ownership sidecar
    // that proved it was the engine's to prune (the GAP-8 fix).
    const result2 = applyPlan(repo, plan2, { sweepOrphans: true });
    expect(result2.swept).toContain('.codex/hooks.json');
    expect(result2.swept).toContain('.codex/hooks.json.dorkos-generated');
    expect(existsSync(hooksPath)).toBe(false);
    expect(existsSync(`${hooksPath}.dorkos-generated`)).toBe(false);
  });

  it('AP-07: keeps a still-generated `.codex/hooks.json` and never prunes an unowned file', () => {
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

    // And an UNOWNED file at the same path — a person's own hooks, with no
    // sidecar — survives a sweep that has every other reason to take it: the
    // plugin is gone, so nothing regenerates the path.
    const mine = '{\n  "hooks": { "Stop": [] }\n}\n';
    writeFileSync(hooksPath, mine);
    rmSync(join(repo, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    rmSync(`${hooksPath}.dorkos-generated`, { force: true });

    expect(sweepGeneratedOrphans(repo, project(repo, { dorkHome }))).toEqual([]);
    expect(readFileSync(hooksPath, 'utf8')).toBe(mine);
  });

  it('HK-02, AP-08: generates cursor + copilot hook files from an authored hook, then prunes each on uninstall (FND-6 + GAP-8)', () => {
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
    expect(swept).toContain('.cursor/hooks.json.dorkos-generated');
    expect(swept).toContain('.github/hooks/copilot-hooks.json');
    expect(swept).toContain('.github/hooks/copilot-hooks.json.dorkos-generated');
    expect(existsSync(cursorPath)).toBe(false);
    expect(existsSync(copilotPath)).toBe(false);
    expect(existsSync(`${cursorPath}.dorkos-generated`)).toBe(false);
    expect(existsSync(`${copilotPath}.dorkos-generated`)).toBe(false);
  });
});
