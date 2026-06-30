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
      { name: 'alpha', sourceDir: '.dork/plugins/my-plugin/skills/alpha' },
      { name: 'beta', sourceDir: '.dork/plugins/my-plugin/.dork/tasks/beta' },
    ]);
    expect(proj.hooks).toHaveProperty('Stop');
    expect(proj.layers).toEqual(['skills', 'extensions', 'hooks']);

    // Global plugin: identity only — no asset enumeration.
    const glob = plugins.find((p) => p.name === 'global-plugin')!;
    expect(glob.scope).toBe('global');
    expect(glob.skills).toEqual([]);
    expect(glob.relDir).toBeUndefined();
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
});
