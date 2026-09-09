/**
 * DOR-1942 — a `native` claim whose enabling link is blocked.
 *
 * An installed package's skill is `native` for OpenCode (and Cursor, Gemini CLI
 * and Copilot) because ANOTHER action writes the `.agents/skills/<pkg>__<name>`
 * link all four read. The claim is true exactly as long as that link is — and
 * after DOR-1882 the write can be a blocked conflict, at which point the plan
 * was still saying "OpenCode reads it" about a link nothing ever wrote.
 *
 * Measured on the combined tree at base `0d3b4192e` by property P9b: plan
 * `[native opencode acme__a, symlink codex acme__a -> .agents/skills/acme__a]`,
 * apply → the symlink blocked by a file at `.agents/skills`, and
 * `harnessCoverage('opencode')` discovering nothing at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import { harnessCoverage } from '../../vendor-facts/coverage.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

const staged: string[] = [];
afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An OpenCode-only project with one installed package, and something in the way
 * of the one link OpenCode would read it through.
 *
 * @param blocker - what to put at `.agents/skills`, or nothing at all.
 * @returns the repository root and its dork home.
 */
function stageOpencodeProject(blocker?: 'file'): { repo: string; dorkHome: string } {
  const repo = mkdtempSync(join(tmpdir(), 'harness-native-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-native-home-'));
  staged.push(repo, dorkHome);
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['opencode'],
  });
  const pkg = join(repo, '.dork', 'plugins', 'acme');
  writeJsonAt(join(pkg, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: 'acme',
    version: '1.0.0',
    type: 'plugin',
    description: 'acme test package',
    layers: ['skills'],
  });
  writeFileAt(
    join(pkg, 'skills', 'a', 'SKILL.md'),
    '---\nname: a\ndescription: A packaged skill\n---\n\n# a\n'
  );
  if (blocker === 'file') writeFileAt(join(repo, '.agents', 'skills'), 'somebody wrote this\n');
  return { repo, dorkHome };
}

describe('AP-11, SK-05, SK-09 — a native the tree cannot make true', () => {
  it('degrades to a drop naming the folder in the way', () => {
    // Seeded defect: skip `degradeUnreachableNatives`. The plan then carries
    // `native opencode acme__a` for a link the very same plan reports as a
    // blocked conflict, and the coverage walk finds nothing (P9b).
    const { repo, dorkHome } = stageOpencodeProject('file');

    const plan = project(repo, { dorkHome });

    expect(plan.actions.filter((a) => a.kind === 'native')).toEqual([]);
    expect(
      plan.drops
        .filter((d) => d.harness === 'opencode' && d.name === 'acme__a')
        .map((d) => d.reason)
    ).toEqual([
      'OpenCode reads .agents/skills, and the link this skill needs there is blocked by ' +
        '`.agents/skills`, which is a file — DorkOS needs a folder there to write this. ' +
        'Move the file aside, then re-run.',
    ]);

    // And the walk agrees, which is the whole point: nothing OpenCode reads
    // holds this skill.
    applyPlan(repo, plan);
    expect(harnessCoverage('opencode', repo).discovered).toEqual([]);
  });

  it('says the same thing in --check as in the plan', () => {
    const { repo, dorkHome } = stageOpencodeProject('file');
    const plan = project(repo, { dorkHome });

    // The link itself is still a blocked conflict — one fault, named once —
    // and the skill it would have carried is a drop rather than a promise.
    expect(checkPlan(repo, plan).blocked.map((a) => a.target)).toEqual(['.agents/skills/acme__a']);
  });

  it('leaves the claim alone when the link really can be written', () => {
    // The silence that must survive: an ordinary project keeps its `native`,
    // and a degrade that fired on a healthy tree would take every installed
    // skill off every OpenCode column at once.
    const { repo, dorkHome } = stageOpencodeProject();

    const plan = project(repo, { dorkHome });

    expect(
      plan.actions.filter((a) => a.kind === 'native' && a.harness === 'opencode').map((a) => a.name)
    ).toEqual(['acme__a']);
  });
});
