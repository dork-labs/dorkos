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

/** A repo with the person's own skills, each `[folder, frontmatter name]` under a root. */
function repoWith(own: Array<[root: string, dir: string, name: string]>): string {
  const repo = mkdtempSync(join(tmpdir(), 'harness-pkg-skill-'));
  roots.push(repo);
  for (const [root, dir, name] of own) {
    mkdirSync(join(repo, root, dir), { recursive: true });
    writeFileSync(
      join(repo, root, dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: the person's own ${name}\n---\n\nmine\n`
    );
  }
  return repo;
}

/** A project-scoped package shipping one skill folder with a frontmatter name. */
function pkg(name: string, dir: string, frontmatterName: string): ProjectInstalledPlugin {
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
        frontmatterName,
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

  it('SK-06: skips nothing when no enabled harness keys skills by name', () => {
    // Claude Code keys by folder and Codex loads both, so neither can lose the person's skill.
    const repo = repoWith([['.agents/skills', 'c', 'c']]);
    const p = plan(repo, [pkg('acme', 'c', 'c')], ['claude-code', 'codex']);

    expect(mentions(p, 'acme__c').length).toBeGreaterThan(0);
    expect(p.skippedPackageSkills).toBeUndefined();
  });

  it('SK-06: skips nothing when the names differ', () => {
    const repo = repoWith([['.agents/skills', 'c', 'c']]);
    const p = plan(repo, [pkg('acme', 'c', 'acme-c')], ALL);

    expect(mentions(p, 'acme__c').length).toBeGreaterThan(0);
    expect(p.skippedPackageSkills).toBeUndefined();
  });
});
