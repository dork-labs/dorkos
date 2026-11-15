import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { parseHarnessManifest, type HarnessId } from '../../manifest/schema.js';
import type { ProjectInstalledPlugin } from '../../sources/installed.js';
import type { ProjectionPlan } from '../types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A repo with the person's own skills, each `[root, folder, name]`. The name is
 * written into the YAML exactly as given (so `'c'` stays quoted), and `null`
 * writes no `name` key at all.
 */
function repoWith(own: Array<[root: string, dir: string, yamlName: string | null]>): string {
  const repo = mkdtempSync(join(tmpdir(), 'harness-pkg-skill-'));
  roots.push(repo);
  for (const [root, dir, yamlName] of own) {
    mkdirSync(join(repo, root, dir), { recursive: true });
    writeFileSync(
      join(repo, root, dir, 'SKILL.md'),
      `---\n${yamlName === null ? '' : `name: ${yamlName}\n`}description: the person's own ${dir}\n---\n\nmine\n`
    );
  }
  return repo;
}

/** A project-scoped package shipping one skill folder; the name is the parsed value, or none. */
function pkg(name: string, dir: string, frontmatterName?: string): ProjectInstalledPlugin {
  return {
    name,
    type: 'skill-pack',
    location: { scope: 'project', relDir: `.dork/plugins/${name}` },
    skills: [
      {
        name: dir,
        sourceDir: `.dork/plugins/${name}/skills/${dir}`,
        usesPluginRoot: false,
        hasSchedule: false,
        ...(frontmatterName === undefined ? {} : { frontmatterName }),
      },
    ],
    commands: [],
    layers: ['skills'],
  };
}

function plan(
  repo: string,
  plugins: ProjectInstalledPlugin[],
  harnesses: HarnessId[]
): ProjectionPlan {
  return buildPlan({
    repoRoot: repo,
    manifest: parseHarnessManifest({ version: 1, harnesses }),
    agentsMdExists: false,
    installedPlugins: plugins,
  });
}

/** Every link or claim the plan makes for one `<pkg>__<skill>` projection. */
function mentions(p: ProjectionPlan, projection: string) {
  return p.actions.filter(
    (a) => a.target?.endsWith(`/${projection}`) || (a.kind === 'native' && a.name === projection)
  );
}

const ALL: HarnessId[] = ['claude-code', 'codex', 'opencode'];

describe('a package skill never replaces a skill with the same name on a by-name harness', () => {
  it("SK-06: skips a package skill named like the person's own skill, and says so", () => {
    const repo = repoWith([['.agents/skills', 'c', 'c']]);
    const p = plan(repo, [pkg('acme', 'c', 'c')], ALL);

    // Nothing is projected for the package's skill, in any folder, for any harness.
    expect(mentions(p, 'acme__c')).toEqual([]);
    // The person's own skill is still there for OpenCode.
    expect(p.actions.some((a) => a.harness === 'opencode' && a.source === '.agents/skills/c')).toBe(
      true
    );
    expect(p.skippedPackageSkills).toEqual([
      {
        package: 'acme',
        skill: 'c',
        name: 'c',
        winner: { kind: 'own', source: '.agents/skills/c' },
      },
    ]);
    const warning = p.warnings.filter((w) => w.name === 'acme__c');
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({ harnessAgnostic: true });
    expect(warning[0].reason).toBe(
      'the "acme" package\'s skill "c" was not added: your own skill at .agents/skills/c has the same name, and your own skill wins. OpenCode keeps only one skill per name'
    );
  });

  it("SK-06: matches the person's skill by its frontmatter name, in any folder OpenCode reads", () => {
    // The person's skill lives in `.claude/skills/my-deploy` but calls itself `deploy`.
    const repo = repoWith([['.claude/skills', 'my-deploy', 'deploy']]);
    const p = plan(repo, [pkg('acme', 'ship', 'deploy')], ALL);

    expect(mentions(p, 'acme__ship')).toEqual([]);
    expect(p.skippedPackageSkills?.[0]?.winner).toEqual({
      kind: 'own',
      source: '.claude/skills/my-deploy',
    });
  });

  it('SK-06: of two package skills with one name, keeps the first and skips the second', () => {
    const repo = repoWith([]);
    const p = plan(repo, [pkg('alpha', 'x', 'shared'), pkg('beta', 'y', 'shared')], ALL);

    expect(mentions(p, 'alpha__x').length).toBeGreaterThan(0);
    expect(mentions(p, 'beta__y')).toEqual([]);
    expect(p.skippedPackageSkills).toEqual([
      {
        package: 'beta',
        skill: 'y',
        name: 'shared',
        winner: { kind: 'package', projection: 'alpha__x' },
      },
    ]);
    expect(p.warnings.find((w) => w.name === 'beta__y')?.reason).toContain(
      'the "alpha__x" skill already added has the same name, and the first one wins'
    );
  });

  it('SK-06: skips it in a project whose manifest does not list OpenCode (DOR-4392)', () => {
    // Every package skill reaches `.agents/skills` whatever the manifest lists,
    // and an agent on OpenCode reads that folder in any project.
    const repo = repoWith([['.agents/skills', 'c', 'c']]);
    const p = plan(repo, [pkg('acme', 'c', 'c')], ['claude-code', 'codex']);

    expect(mentions(p, 'acme__c')).toEqual([]);
    expect(p.actions.some((a) => a.source === '.agents/skills/c')).toBe(true);
    expect(p.skippedPackageSkills?.map((s) => s.package)).toEqual(['acme']);
  });

  it('SK-06: skips nothing when the names differ', () => {
    const repo = repoWith([['.agents/skills', 'c', 'c']]);
    const p = plan(repo, [pkg('acme', 'c', 'acme-c')], ALL);

    expect(mentions(p, 'acme__c').length).toBeGreaterThan(0);
    expect(p.skippedPackageSkills).toBeUndefined();
  });
});

// Two names are one name exactly when OpenCode treats them as one, measured on
// the pinned `opencode 1.19.3` (`opencode debug skill`, DOR-4392).
describe('same-name matching follows OpenCode', () => {
  const skips = (yamlName: string | null, packageName: string | undefined) => {
    const repo = repoWith([['.agents/skills', 'mine', yamlName]]);
    return plan(repo, [pkg('acme', 'theirs', packageName)], ALL).skippedPackageSkills ?? [];
  };

  it.each([
    ['single-quoted', "'c'", 'c'],
    ['double-quoted', '"c"', 'c'],
    ['blank names', '""', ''],
  ])('SK-06: treats %s YAML as the same name', (_label, yamlName, packageName) => {
    expect(skips(yamlName, packageName).map((s) => s.package)).toEqual(['acme']);
  });

  it.each([
    ['a different case', 'c', 'C'],
    ['a trailing space', 'c', 'c '],
    ['a leading space', 'c', ' c'],
    ['NFC against NFD', 'café', 'café'],
    ['a fullwidth letter', 'c', 'ｃ'],
    ['two inner spaces', 'a b', 'a  b'],
  ])(
    'SK-06: keeps names apart that differ by %s, as OpenCode does',
    (_label, yamlName, packageName) => {
      expect(skips(yamlName, packageName)).toEqual([]);
    }
  );

  it("SK-06: matches the person's quoted name exactly, spaces included", () => {
    // OpenCode keys `" c"` as ` c`; a trimmed comparison would miss this pair.
    expect(skips('" c"', ' c').map((s) => s.package)).toEqual(['acme']);
  });

  it('SK-06: has no folder-name fallback, because OpenCode loads no skill without a name', () => {
    // The person's nameless `c` folder is not loaded, so a package `c` shadows nothing.
    const repo = repoWith([['.agents/skills', 'c', null]]);
    expect(plan(repo, [pkg('acme', 'c', 'c')], ALL).skippedPackageSkills).toBeUndefined();
    // And a nameless package skill is never loaded, so it is never skipped.
    expect(skips('c', undefined)).toEqual([]);
  });
});
