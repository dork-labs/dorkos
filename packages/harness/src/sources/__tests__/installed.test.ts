import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_TEXT_MAX_BYTES } from '@dorkos/shared/bounded-read';
import { scanInstalledPlugins, type UnreadableHookDeclaration } from '../installed.js';
import type { ClaudeHooksConfig } from '../../generate/hooks.js';

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
  it("never reads the install engine's own siblings as plugins (DOR-2273)", () => {
    // A crash mid-reinstall leaves `<name>.dorkos-bak-<ts>-<uuid>` beside the
    // package: the previous install, valid manifest and skills included. Read
    // as a plugin it would project a second copy of every skill it carries.
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-home-'));
    const stamp = `${Date.now()}-3fa85f64-5717-4562-b3fc-2c963f66afa6`;
    for (const root of [join(projectRoot, '.dork', 'plugins'), join(dorkHome, 'plugins')]) {
      writeManifest(join(root, 'flow'), 'flow', ['skills']);
      writeManifest(join(root, `flow.dorkos-bak-${stamp}`), 'flow', ['skills']);
      writeManifest(join(root, `flow.dorkos-bak-${stamp}.committed`), 'flow', ['skills']);
      // The installed copy a dev link set aside (DOR-2696): no stamp, still hidden.
      writeManifest(join(root, 'flow.dorkos-devlink-parked'), 'flow', ['skills']);
    }

    const plugins = scanInstalledPlugins({ dorkHome, projectRoot });

    expect(plugins.map((p) => `${p.location.scope}:${p.name}`)).toEqual([
      'global:flow',
      'project:flow',
    ]);
  });

  it('SRC-02: discovers project + global plugins and enumerates project portable assets', () => {
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

    expect(plugins.map((p) => `${p.location.scope}:${p.name}`)).toEqual([
      'global:global-plugin',
      'project:my-plugin',
    ]);

    const proj = plugins.find((p) => p.name === 'my-plugin')!;
    expect(proj.location).toEqual({ scope: 'project', relDir: '.dork/plugins/my-plugin' });
    expect(proj.skills).toEqual([
      {
        name: 'alpha',
        sourceDir: '.dork/plugins/my-plugin/skills/alpha',
        usesPluginRoot: false,
        usesPluginData: false,
        hasSchedule: false,
      },
      {
        name: 'beta',
        sourceDir: '.dork/plugins/my-plugin/.dork/tasks/beta',
        usesPluginRoot: false,
        usesPluginData: false,
        hasSchedule: false,
      },
    ]);
    expect(proj.hooks).toHaveProperty('Stop');
    expect(proj.layers).toEqual(['skills', 'extensions', 'hooks']);

    // Global plugin: enumerated too, against its absolute install directory
    // (DOR-1922). What it holds is reported; where it can reach is the drop's
    // subject, not the scan's.
    const glob = plugins.find((p) => p.name === 'global-plugin')!;
    expect(glob.location).toEqual({ scope: 'global', absDir: globalPlugin });
    expect(glob.skills).toEqual([
      {
        name: 'gamma',
        sourceDir: `${globalPlugin}/skills/gamma`,
        usesPluginRoot: false,
        usesPluginData: false,
        hasSchedule: false,
        linkedInDorkHome: false,
      },
    ]);
    expect(glob.commands).toEqual([]);
  });

  it('does NOT collect a skill dir that is a symlink escaping the install dir, from EITHER root', () => {
    // A marketplace install can never produce this: `stagePackageContents`
    // strips every symlink as it copies (DOR-279). But `dorkos harness sync`
    // walks `.dork/plugins/` on its own, so a tree put there by anything else —
    // a hand-unpacked package, a restored backup — reaches this scan. Following
    // the link would project `.agents/skills/evil__stolen` and
    // `.claude/skills/evil__stolen` at a directory outside the repo entirely,
    // and then serve its SKILL.md through the palette and `dorkos://skills`.
    //
    // BOTH portable roots are covered, and `.dork/tasks` is the half that
    // matters more: a task skill carrying a `schedule:` block is linked into
    // `.agents/skills` by `planCanonicalSkillLinks` whatever harnesses the
    // project enables (DOR-1518, DOR-1847), and what lands there gets offered for
    // approval and then RUNS. `skills/` alone leaving `.dork/tasks/` unguarded
    // is a live mutant, so it is named here rather than left to the reader.
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-victim-'));
    writeSkill(dorkHome, 'private'); // the directory outside the plugin

    const plugin = join(projectRoot, '.dork', 'plugins', 'evil');
    writeManifest(plugin, 'evil', ['skills']);
    writeSkill(join(plugin, 'skills'), 'honest');
    writeSkill(join(plugin, '.dork', 'tasks'), 'chore');
    symlinkSync(join(dorkHome, 'private'), join(plugin, 'skills', 'stolen'));
    symlinkSync(join(dorkHome, 'private'), join(plugin, '.dork', 'tasks', 'stolen-task'));

    // Sorted by name, so the two real skills and neither link.
    const [evil] = scanInstalledPlugins({ projectRoot });
    expect(evil?.skills.map((s) => s.name)).toEqual(['chore', 'honest']);
  });
});

describe('scanInstalledPlugins — malformed hook matcher groups (DOR-646)', () => {
  /** Write a plugin whose only content is the given raw `hooks/hooks.json` text. */
  function writeHookyPlugin(hooksJson: string): void {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-home-'));
    const plugin = join(projectRoot, '.dork', 'plugins', 'hooky');
    writeManifest(plugin, 'hooky', ['hooks']);
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), hooksJson);
  }

  /** Scan and return the `hooky` fixture plugin's normalized hooks. */
  function scanHooks(): ClaudeHooksConfig | undefined {
    return scanInstalledPlugins({ dorkHome, projectRoot }).find((p) => p.name === 'hooky')?.hooks;
  }

  it('treats a hooks.json larger than DorkOS reads as unreadable, without loading it (DOR-2321)', () => {
    // Purpose: installed package files are read within the package-file size
    // limit, so an oversized hooks.json yields no hooks rather than a huge read.
    writeHookyPlugin(
      JSON.stringify({ Stop: [{ hooks: [{ command: 'good.sh' }] }] }) +
        ' '.repeat(PACKAGE_TEXT_MAX_BYTES)
    );
    expect(scanHooks()).toBeUndefined();
  });

  it('HK-09: keeps the readable group when one good and one bad group share an event', () => {
    writeHookyPlugin(
      JSON.stringify({ Stop: [{ hooks: [{ command: 'good.sh' }] }, { hooks: 'nope' }] })
    );
    expect(scanHooks()).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'good.sh' }] }] });
  });
});

describe('scanInstalledPlugins — salvaged-hooks evidence (DOR-1724)', () => {
  /** Write a plugin whose only content is the given raw `hooks/hooks.json` text. */
  function writeHookyPlugin(hooksJson: string): void {
    projectRoot = mkdtempSync(join(tmpdir(), 'harness-proj-'));
    dorkHome = mkdtempSync(join(tmpdir(), 'harness-home-'));
    const plugin = join(projectRoot, '.dork', 'plugins', 'hooky');
    writeManifest(plugin, 'hooky', ['hooks']);
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), hooksJson);
  }

  /** Scan and return the `hooky` fixture plugin's unreadable-hook evidence. */
  function scanUnreadable(): UnreadableHookDeclaration[] | undefined {
    return scanInstalledPlugins({ dorkHome, projectRoot }).find((p) => p.name === 'hooky')
      ?.unreadableHooks;
  }

  const HOOKS_FILE = '.dork/plugins/hooky/hooks/hooks.json';

  it('HK-09: records a PARTIAL loss when a readable group survives beside a bad one', () => {
    writeHookyPlugin(
      JSON.stringify({ Stop: [{ hooks: [{ command: 'good.sh' }] }, { hooks: 'nope' }] })
    );
    expect(scanUnreadable()).toEqual([{ path: HOOKS_FILE, event: 'Stop', total: false }]);
  });
});
