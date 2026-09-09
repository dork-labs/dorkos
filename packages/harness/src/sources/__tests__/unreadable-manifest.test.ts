/**
 * A package whose `.dork/manifest.json` will not parse — named, never vanished
 * (SRC-04, SRC-12, DOR-1933).
 *
 * `readPluginManifest` answered `undefined` for a manifest that was THERE and
 * would not parse, exactly as it does for one that is absent, so `scanPluginsRoot`
 * skipped the package and it left no trace anywhere: not in the scan, not in the
 * plan, not in the drop list, not in the status model, not in the terminal. A
 * person who broke a manifest half an hour ago was told nothing at all — the
 * package simply stopped being mentioned. Measured during DOR-1922's review.
 *
 * The sweep has always kept such a package's links (clause 4 of the global
 * predicate: a package still on disk that the plan did not enumerate keeps
 * everything it owns). That half was right and is unchanged here. What was
 * missing is the sentence that goes with it, and the two must agree: the report
 * says the package could not be read and its links were left alone, and the
 * sweep leaves them alone.
 *
 * @module sources/__tests__/unreadable-manifest
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstalledSources } from '../installed.js';
import { globalSkillsDir, projectGlobal } from '../../plan/global-projector.js';
import { findGlobalOrphans } from '../../apply/global-apply.js';
import { project } from '../../engine.js';

/** Every temp tree a case staged. */
const staged: string[] = [];

afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `SKILL.md` with no schedule. */
function plainSkillMd(name: string): string {
  return `---\nname: ${name}\ndescription: A skill named ${name}\n---\nJust a skill.\n`;
}

/**
 * Stage one package under `pluginsRoot`, with `manifest` written verbatim so a
 * case can put bytes there that will not parse.
 */
function stagePackage(
  pluginsRoot: string,
  dirName: string,
  manifest: string,
  skills: string[]
): string {
  const dir = join(pluginsRoot, dirName);
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(join(dir, '.dork', 'manifest.json'), manifest);
  for (const skill of skills) {
    mkdirSync(join(dir, 'skills', skill), { recursive: true });
    writeFileSync(join(dir, 'skills', skill, 'SKILL.md'), plainSkillMd(skill));
  }
  return dir;
}

/** A valid package manifest, as JSON text. */
function goodManifest(name: string): string {
  return JSON.stringify({ name, version: '1.0.0', type: 'plugin', description: name });
}

/** A fresh dork home holding one broken package and one good one. */
function stageDorkHome(): { dorkHome: string; brokenDir: string } {
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-badmanifest-'));
  staged.push(dorkHome);
  const plugins = join(dorkHome, 'plugins');
  const brokenDir = stagePackage(plugins, 'badmanifest', '{ not json', ['greet']);
  stagePackage(plugins, 'goodpkg', goodManifest('goodpkg'), ['wave']);
  return { dorkHome, brokenDir };
}

describe('SRC-04 — a manifest DorkOS cannot read is named, not dropped', () => {
  it('SRC-04: the scan records the package and the file it could not read', () => {
    const { dorkHome, brokenDir } = stageDorkHome();

    const scan = scanInstalledSources({ dorkHome });

    expect(scan.plugins.map((p) => p.name)).toEqual(['goodpkg']);
    expect(scan.unreadableManifests).toEqual([
      {
        package: 'badmanifest',
        path: join(brokenDir, '.dork', 'manifest.json'),
        scope: 'global',
      },
    ]);
  });

  it('SRC-04: the global plan warns once, agnostically, and does not enumerate the package', () => {
    const { dorkHome, brokenDir } = stageDorkHome();

    const plan = projectGlobal({ roots: { dorkHome }, harnesses: [] });

    const about = plan.warnings.filter((w) => w.name === 'badmanifest');
    expect(about).toHaveLength(1);
    expect(about[0]?.harnessAgnostic).toBe(true);
    expect(about[0]?.source).toBe(join(brokenDir, '.dork', 'manifest.json'));
    expect(about[0]?.reason).toContain('badmanifest');
    expect(about[0]?.reason).toContain(join(brokenDir, '.dork', 'manifest.json'));

    // The plan is evidence only about packages it could read, and the sweep
    // reads `enumeratedPackages` as exactly that. A broken manifest joining this
    // list would make the sweep delete every link the package owns.
    expect(plan.enumeratedPackages).toEqual(['goodpkg']);
  });

  it('SRC-04: the record and the kept links agree — the sweep removes nothing', () => {
    const { dorkHome } = stageDorkHome();
    const skillsDir = globalSkillsDir(dorkHome);
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(
      join(dorkHome, 'plugins', 'badmanifest', 'skills', 'greet'),
      join(skillsDir, 'badmanifest__greet')
    );

    const plan = projectGlobal({ roots: { dorkHome }, harnesses: [] });

    expect(findGlobalOrphans(plan, { dorkHome })).toEqual([]);
    expect(plan.warnings.some((w) => w.name === 'badmanifest')).toBe(true);
  });

  it('SRC-04: a project-scoped package gets the same sentence, spelled repo-relative', () => {
    const repo = mkdtempSync(join(tmpdir(), 'harness-badmanifest-repo-'));
    staged.push(repo);
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code'] })
    );
    stagePackage(join(repo, '.dork', 'plugins'), 'badmanifest', '{ not json', ['greet']);

    const plan = project(repo);

    const about = plan.warnings.filter((w) => w.name === 'badmanifest');
    expect(about).toHaveLength(1);
    expect(about[0]?.harnessAgnostic).toBe(true);
    expect(about[0]?.source).toBe('.dork/plugins/badmanifest/.dork/manifest.json');
  });
});
