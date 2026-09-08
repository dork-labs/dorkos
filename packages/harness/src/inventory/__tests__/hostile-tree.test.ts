/**
 * The inventory over a tree that is wrong in every way a real tree gets wrong.
 *
 * `dorkos harness sync` runs in other people's repositories, and other people's
 * repositories have a file where a directory should be, a link whose target was
 * renamed, and a config half-written by an editor that crashed. Each of those is
 * something a person can see and fix, so each becomes a record with a path and a
 * reason — and `project()` and `checkPlan()` still return.
 *
 * A throw here is the failure mode under test: before the inventory existed the
 * engine never opened any of these files, so it could not crash on them; the
 * moment it started reading them, an unguarded `readFileSync` would take the
 * whole command down over somebody's dangling symlink.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventorySourceTree } from '../index.js';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * Stage a repository whose four source paths are each broken in a different way,
 * with one intact skill and one intact rule so the walk has something to find.
 */
function stageHostileRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-hostile-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-hostile-home-'));

  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex'],
  });

  // 1. `.claude/agents` is a FILE where a directory belongs.
  writeFileAt(join(repo, '.claude', 'agents'), 'someone put notes here\n');

  // 2. `.claude/rules/dead.md` is a link whose target moved. `intact.md` beside it
  //    proves the walk keeps going rather than stopping at the first failure.
  const rules = join(repo, '.claude', 'rules');
  mkdirSync(rules, { recursive: true });
  symlinkSync('../../rules-that-moved/dead.md', join(rules, 'dead.md'));
  writeFileSync(join(rules, 'intact.md'), '---\npaths: src/**/*.ts\n---\n\n# intact\n');

  // 3. `.mcp.json` was half-written.
  writeFileAt(join(repo, '.mcp.json'), '{ "mcpServers": { "linear": ');

  // 4. A SKILL.md whose frontmatter will not parse: the skill is real, its
  //    `hooks:` are unknowable.
  writeFileAt(
    join(repo, '.agents', 'skills', 'broken', 'SKILL.md'),
    '---\nname: broken\ndescription: "unclosed\nhooks: [\n---\n\n# broken\n'
  );
}

/** The one reason recorded for a source, or a message naming what was recorded instead. */
function reasonFor(sources: { source: string; reason: string }[], source: string): string {
  const found = sources.filter((entry) => entry.source === source);
  return found.length === 1
    ? found[0].reason
    : `expected one entry for ${source}, got ${found.length}`;
}

describe('a hostile source tree', () => {
  it('records a reason for each broken source instead of throwing', () => {
    stageHostileRepo();
    const inventory = inventorySourceTree(repo);

    expect(inventory.unreadable.map((u) => `${u.kind}:${u.source}`).sort()).toEqual([
      'agent:.claude/agents',
      'hook:.agents/skills/broken/SKILL.md',
      'mcp:.mcp.json',
      'rule:.claude/rules/dead.md',
    ]);
    expect(reasonFor(inventory.unreadable, '.claude/agents')).toContain('could not be listed');
    expect(reasonFor(inventory.unreadable, '.claude/rules/dead.md')).toContain('could not be read');
    expect(reasonFor(inventory.unreadable, '.mcp.json')).toContain('not valid JSON');
    expect(reasonFor(inventory.unreadable, '.agents/skills/broken/SKILL.md')).toContain(
      'frontmatter this reader cannot parse'
    );

    // The walk kept going: the intact rule and the real skill are still found,
    // and nothing was invented for the broken sources.
    expect(inventory.rules.map((r) => r.name)).toEqual(['intact']);
    expect(inventory.skills.map((s) => s.name)).toEqual(['broken']);
    expect({ agents: inventory.agents.length, mcp: inventory.mcpServers.length }).toEqual({
      agents: 0,
      mcp: 0,
    });
  });

  it('turns every unreadable source into one plan warning, and neither check nor fix throws', () => {
    stageHostileRepo();

    const plan = project(repo, { dorkHome });
    const warned = plan.warnings.filter((w) => w.source !== undefined);
    expect(warned.map((w) => `${w.artifact}:${w.source}`).sort()).toEqual([
      'agent:.claude/agents',
      'hook:.agents/skills/broken/SKILL.md',
      'mcp:.mcp.json',
      'rule:.claude/rules/dead.md',
    ]);
    // Once per source, ahead of every harness — not once per enabled harness.
    for (const warning of warned) expect(warning.harness).toBe('claude-code');

    expect(() => checkPlan(repo, plan)).not.toThrow();
    expect(() => applyPlan(repo, plan, { sweepOrphans: true })).not.toThrow();
  });

  it('reports a `.mcp.json` whose "mcpServers" key is not an object rather than reading it', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-hostile-mcp-'));
    writeJsonAt(join(repo, '.mcp.json'), { mcpServers: ['linear', 'shadcn'] });

    const inventory = inventorySourceTree(repo);
    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.unreadable.length).toBe(1);
    expect(inventory.unreadable[0].reason).toContain('is not an object');
  });

  it('reports a skills root that is a file rather than crashing the whole walk', () => {
    // `scanSkillDirs` guards an absent directory and nothing else, so this threw
    // ENOTDIR straight out of `project()` until the inventory probed the root
    // first. The engine had a test for the same shape on the orphan sweep; the
    // inventory arrived and could reach the same directory a second way.
    repo = mkdtempSync(join(tmpdir(), 'harness-hostile-skills-'));
    writeFileAt(join(repo, '.claude', 'skills'), 'not a directory\n');
    writeFileAt(
      join(repo, '.agents', 'skills', 'fine', 'SKILL.md'),
      '---\nname: fine\ndescription: A fine skill\n---\n\n# fine\n'
    );

    const inventory = inventorySourceTree(repo);
    expect(inventory.skills.map((s) => s.name)).toEqual(['fine']);
    expect(inventory.unreadable.map((u) => `${u.kind}:${u.source}`)).toEqual([
      'skill:.claude/skills',
    ]);
  });

  it('reports a settings file whose "hooks" key is not an object', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-hostile-hooks-'));
    writeJsonAt(join(repo, '.claude', 'settings.json'), { hooks: 'all of them' });
    writeFileAt(join(repo, '.claude', 'settings.local.json'), '{ oops');

    const inventory = inventorySourceTree(repo);
    expect(inventory.hooks).toEqual([]);
    expect(inventory.unreadable.map((u) => u.source)).toEqual([
      '.claude/settings.json',
      '.claude/settings.local.json',
    ]);
  });
});
