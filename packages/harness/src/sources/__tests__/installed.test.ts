import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstalledPlugins } from '../installed.js';

let projectRoot = '';
let dorkHome = '';
afterEach(() => {
  for (const d of [projectRoot, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  projectRoot = '';
  dorkHome = '';
});

/** Write a minimal valid `.dork/manifest.json` for a plugin package. */
function writeManifest(pluginDir: string, name: string, layers: string[]): void {
  mkdirSync(join(pluginDir, '.dork'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'plugin',
      description: 'A fixture plugin',
      layers,
    })
  );
}

/** Write a `<name>/SKILL.md` skill dir under `parent`. */
function writeSkill(parent: string, name: string): void {
  mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(join(parent, name, 'SKILL.md'), `# ${name}\n`);
}

describe('scanInstalledPlugins', () => {
  it('discovers project + global plugins and enumerates project portable assets', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-home-'));

    // Project-scoped plugin with a skill, a task (both SKILL.md), and hooks.
    const projPlugin = join(projectRoot, '.dork', 'plugins', 'my-plugin');
    writeManifest(projPlugin, 'my-plugin', ['skills', 'extensions', 'hooks']);
    writeSkill(join(projPlugin, 'skills'), 'alpha');
    writeSkill(join(projPlugin, '.dork', 'tasks'), 'beta');
    mkdirSync(join(projPlugin, 'hooks'), { recursive: true });
    writeFileSync(
      join(projPlugin, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
    );

    // Global-scoped plugin (identity only).
    const globalPlugin = join(dorkHome, 'plugins', 'global-plugin');
    writeManifest(globalPlugin, 'global-plugin', ['skills']);
    writeSkill(join(globalPlugin, 'skills'), 'gamma');

    const plugins = scanInstalledPlugins({ dorkHome, projectRoot });

    expect(plugins.map((p) => `${p.scope}:${p.name}`)).toEqual([
      'global:global-plugin',
      'project:my-plugin',
    ]);

    const proj = plugins.find((p) => p.name === 'my-plugin')!;
    expect(proj.relDir).toBe('.dork/plugins/my-plugin');
    expect(proj.skills).toEqual([
      { name: 'alpha', sourceDir: '.dork/plugins/my-plugin/skills/alpha', usesPluginRoot: false },
      {
        name: 'beta',
        sourceDir: '.dork/plugins/my-plugin/.dork/tasks/beta',
        usesPluginRoot: false,
      },
    ]);
    expect(proj.hooks).toHaveProperty('Stop');
    expect(proj.layers).toEqual(['skills', 'extensions', 'hooks']);

    // Global plugin: identity only — no asset enumeration.
    const glob = plugins.find((p) => p.name === 'global-plugin')!;
    expect(glob.scope).toBe('global');
    expect(glob.skills).toEqual([]);
    expect(glob.commands).toEqual([]);
    expect(glob.relDir).toBeUndefined();
  });

  it('enumerates top-level command files and flags skills that use the plugin-root token', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));

    const plugin = join(projectRoot, '.dork', 'plugins', 'flowy');
    writeManifest(plugin, 'flowy', ['commands', 'skills']);
    // A skill whose SKILL.md references the plugin-root token, and one that does not.
    mkdirSync(join(plugin, 'skills', 'uses-token'), { recursive: true });
    writeFileSync(
      join(plugin, 'skills', 'uses-token', 'SKILL.md'),
      '# uses\nRead ${CLAUDE_PLUGIN_ROOT}/x\n'
    );
    writeSkill(join(plugin, 'skills'), 'plain');
    // Two top-level commands plus a nested file (nested is ignored).
    mkdirSync(join(plugin, 'commands', 'nested'), { recursive: true });
    writeFileSync(join(plugin, 'commands', 'capture.md'), '# capture\n');
    writeFileSync(join(plugin, 'commands', 'triage.md'), '# triage\n');
    writeFileSync(join(plugin, 'commands', 'nested', 'deep.md'), '# deep\n');

    const proj = scanInstalledPlugins({ projectRoot }).find((p) => p.name === 'flowy')!;

    expect(proj.commands).toEqual([
      {
        name: 'capture',
        sourcePath: '.dork/plugins/flowy/commands/capture.md',
        content: '# capture\n',
      },
      {
        name: 'triage',
        sourcePath: '.dork/plugins/flowy/commands/triage.md',
        content: '# triage\n',
      },
    ]);
    expect(proj.skills.find((s) => s.name === 'uses-token')?.usesPluginRoot).toBe(true);
    expect(proj.skills.find((s) => s.name === 'plain')?.usesPluginRoot).toBe(false);
  });

  it('reads the SKILL.md frontmatter `name` (the effective identity in frontmatter-keyed harnesses)', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));

    const plugin = join(projectRoot, '.dork', 'plugins', 'flowy');
    writeManifest(plugin, 'flowy', ['skills']);
    // A skill whose DIRECTORY name differs from its frontmatter `name`.
    mkdirSync(join(plugin, 'skills', 'capturing'), { recursive: true });
    writeFileSync(
      join(plugin, 'skills', 'capturing', 'SKILL.md'),
      '---\nname: capturing-work\ndescription: cap\n---\n# body\n'
    );
    // A skill with no frontmatter at all → no frontmatter name.
    writeSkill(join(plugin, 'skills'), 'plain');

    const proj = scanInstalledPlugins({ projectRoot }).find((p) => p.name === 'flowy')!;
    expect(proj.skills.find((s) => s.name === 'capturing')?.frontmatterName).toBe('capturing-work');
    expect(proj.skills.find((s) => s.name === 'plain')?.frontmatterName).toBeUndefined();
  });

  it('scans project plugins (and skips the global scope) when no dorkHome is given', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));

    const projPlugin = join(projectRoot, '.dork', 'plugins', 'my-plugin');
    writeManifest(projPlugin, 'my-plugin', ['skills']);
    writeSkill(join(projPlugin, 'skills'), 'alpha');

    // No `dorkHome` — global scope is skipped, project scope is still scanned.
    const plugins = scanInstalledPlugins({ projectRoot });

    expect(plugins.map((p) => `${p.scope}:${p.name}`)).toEqual(['project:my-plugin']);
    const proj = plugins[0]!;
    expect(proj.skills).toEqual([
      { name: 'alpha', sourceDir: '.dork/plugins/my-plugin/skills/alpha', usesPluginRoot: false },
    ]);
  });

  it('skips a plugin with a missing or invalid manifest', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-home-'));

    // No .dork/manifest.json at all.
    mkdirSync(join(projectRoot, '.dork', 'plugins', 'no-manifest', 'skills'), { recursive: true });
    // Invalid manifest (missing required fields).
    const bad = join(projectRoot, '.dork', 'plugins', 'bad');
    mkdirSync(join(bad, '.dork'), { recursive: true });
    writeFileSync(join(bad, '.dork', 'manifest.json'), JSON.stringify({ name: 'bad' }));

    expect(scanInstalledPlugins({ dorkHome, projectRoot })).toEqual([]);
  });

  it('returns nothing when neither plugins root exists', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-home-'));
    expect(scanInstalledPlugins({ dorkHome, projectRoot })).toEqual([]);
  });

  it('drops malformed (non-array) hook event values instead of crashing the merge', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-home-'));

    const plugin = join(projectRoot, '.dork', 'plugins', 'hooky');
    writeManifest(plugin, 'hooky', ['hooks']);
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
    // `Stop` is a valid array; `Bad` is an object (a real-world malformation that
    // would crash `[...groups]` if accepted) — only `Stop` survives.
    writeFileSync(
      join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({
        Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }],
        Bad: { type: 'command', command: 'echo nope' },
      })
    );

    const proj = scanInstalledPlugins({ dorkHome, projectRoot }).find((p) => p.name === 'hooky')!;
    expect(proj.hooks).toHaveProperty('Stop');
    expect(proj.hooks).not.toHaveProperty('Bad');
  });
});
