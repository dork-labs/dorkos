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
    const swept = sweepInstalledOrphans(repo, { actions: [], drops: [] });

    // The symlink is swept; the hand-authored real directory is untouched.
    expect(swept).toEqual(['.agents/skills/gone__skill']);
    expect(existsSync(orphan)).toBe(false);
    expect(lstatSync(join(skillsDir, 'my__helper')).isDirectory()).toBe(true);
    expect(readFileSync(join(skillsDir, 'my__helper', 'SKILL.md'), 'utf8')).toBe(
      '# precious, do not delete\n'
    );
  });
});
