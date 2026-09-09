/**
 * VC-01 — the derivation table, pinned against real trees.
 *
 * The main fixture is the J-01 journey repository, staged here the way
 * `packages/harness/src/__tests__/journeys/j01-claude-project-nothing-silent.test.ts`
 * stages it: a root `CLAUDE.md`, six skills as real directories under
 * `.claude/skills/`, two commands, one subagent, three rules (one with globs, one
 * whose `paths` frontmatter will not parse, one with no frontmatter at all),
 * hooks in both settings files, one skill declaring hooks in its own frontmatter,
 * and a `.mcp.json` with two servers. No `.agents/`, no `AGENTS.md`; the manifest
 * enables `claude-code, codex, cursor`.
 *
 * It is staged here rather than imported because that journey's helpers live in
 * `packages/harness/src/__tests__/`, which is inside another package's test tree
 * and reachable from here only by a relative path out of this package's root.
 *
 * Real `mkdtempSync` temp directories throughout, and no `node:fs` mocks: every
 * claim in this file is about what is on disk, and a mocked filesystem would let
 * the fixture and the engine agree with each other while both being wrong.
 *
 * Six smaller trees cover what J-01 cannot produce — a declared Claude-only
 * skill, a skill in both roots (which is also the occupied-symlink-target case),
 * an installed package whose hooks nobody has allowed, a package with a
 * non-portable layer and an unreadable `hooks/hooks.json`, a source the inventory
 * could not read at all, and two trees whose only fault is orphans.
 *
 * Every test states the seeded defect that reds it, because none of this exists
 * on `main` and "fails on main" would therefore prove nothing.
 *
 * @module services/harness/__tests__/status-model
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diffSnapshots, snapshotTree } from '@dorkos/harness/journeys';
import { JUNCTION_COMMIT_WARNING } from '@dorkos/harness';
import { HarnessStatusResponseSchema } from '@dorkos/shared/harness-schemas';
import type { HarnessCell, HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { hookApprovalEntry, type HookDecisions } from '../hook-consent.js';
import { projectWithConsent, scanHookRequests } from '../project-with-consent.js';
import { buildHarnessStatus, harnessRowKey } from '../status.js';

/** Nobody has decided anything — the shape every case here runs under. */
const NO_DECISIONS: HookDecisions = { approved: [], refused: [] };

/** The date the vendor facts these reasons cite were fetched. */
const CITED = '(vendor docs, 2026-09-07)';

/** Temp directories to remove when the case ends. */
const staged: string[] = [];

afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh repository root and DorkOS data directory, both cleaned up after. */
function tempPair(tag: string): { repo: string; home: string } {
  const repo = mkdtempSync(join(tmpdir(), `status-${tag}-repo-`));
  const home = mkdtempSync(join(tmpdir(), `status-${tag}-home-`));
  staged.push(repo, home);
  return { repo, home };
}

/** Write a file, creating the directories above it. */
function writeAt(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Write a JSON file, creating the directories above it. */
function writeJsonAt(path: string, value: unknown): void {
  writeAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write a `SKILL.md` for a skill directory that already exists. */
function writeSkill(dir: string, name: string, extraFrontmatter = ''): void {
  writeAt(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n${extraFrontmatter}---\n\n# ${name}\n`
  );
}

/** The status of a project, with the decisions stated so no config store is opened. */
function statusOf(repo: string, home: string): HarnessStatusResponse {
  return buildHarnessStatus({ projectPath: repo, dorkHome: home, decisions: NO_DECISIONS });
}

/**
 * Sync the tree the way a person who allowed every package would.
 *
 * Used only to STAGE the two orphan cases: they are about a projection that
 * exists on disk after its source is gone, so the projection has to have been
 * made for real.
 */
function syncEverything(repo: string, home: string): void {
  const decisions: HookDecisions = {
    approved: scanHookRequests(repo, home).map(hookApprovalEntry),
    refused: [],
  };
  projectWithConsent(repo, { dorkHome: home, decisions, sweepOrphans: true });
}

/**
 * What changed under `root` while `run` ran — added, changed and removed paths.
 *
 * Content-hashed, not a path listing: the projection's commonest write is a
 * MERGE into a `.claude/settings.local.json` that already exists, which changes
 * bytes and no paths at all. A shape-only comparison is green through it, which
 * is the read-only claim's whole subject.
 */
function treeDiffWhile(root: string, run: () => void): ReturnType<typeof diffSnapshots> {
  const before = snapshotTree(root);
  run();
  return diffSnapshots(before, snapshotTree(root));
}

/** A diff naming nothing — what a read is allowed to leave behind. */
const NO_CHANGES = { added: [], changed: [], removed: [] };

/** One row, found by the three components of its key. */
function row(
  status: HarnessStatusResponse,
  artifact: string,
  source: string | undefined,
  name: string
): HarnessStatusResponse['rows'][number] {
  const found = status.rows.filter(
    (r) => r.artifact === artifact && r.source === source && r.name === name
  );
  expect(found, `one row for (${artifact}, ${source ?? '-'}, ${name})`).toHaveLength(1);
  return found[0] as HarnessStatusResponse['rows'][number];
}

/** Every cell in the response, flattened. */
function allCells(status: HarnessStatusResponse): (HarnessCell | undefined)[] {
  return status.rows.flatMap((r) => Object.values(r.cells));
}

/** How many rows of each artifact kind the response holds. */
function rowsByArtifact(status: HarnessStatusResponse): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of status.rows) counts[r.artifact] = (counts[r.artifact] ?? 0) + 1;
  return counts;
}

/** How many `dropped` cells each harness holds. */
function dropsByHarness(status: HarnessStatusResponse): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of status.rows) {
    for (const [harness, cell] of Object.entries(r.cells)) {
      if (cell?.state === 'dropped') counts[harness] = (counts[harness] ?? 0) + 1;
    }
  }
  return counts;
}

/** The six skills the J-01 team keeps as real directories in `.claude/skills`. */
const J01_SKILLS = ['deploy-check', 'lint-fix', 'notes', 'release', 'review', 'triage'] as const;

/**
 * Stage the J-01 repository — a real Claude Code project and nothing else.
 *
 * The manifest is written rather than scaffolded, because detection would enable
 * `claude-code` alone and the whole subject here is what a person sees once they
 * turn Codex and Cursor on.
 */
function stageJ01(): { repo: string; home: string } {
  const { repo, home } = tempPair('j01');
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex', 'cursor'],
  });
  writeAt(join(repo, 'CLAUDE.md'), '# Our project\n\nHouse rules.\n');
  for (const name of J01_SKILLS) {
    const hooks =
      name === 'release'
        ? 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./scripts/guard.sh\n'
        : '';
    writeSkill(join(repo, '.claude', 'skills', name), name, hooks);
  }
  for (const name of ['deploy', 'review']) {
    writeAt(join(repo, '.claude', 'commands', `${name}.md`), `# /${name}\n`);
  }
  writeAt(
    join(repo, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews a diff\n---\n\n# reviewer\n'
  );
  // `testing`'s globs are the YAML trap: a bare `**` opens a scalar with `*`,
  // which YAML reads as an alias, so its frontmatter does not parse.
  for (const rule of [
    { name: 'api', paths: 'apps/server/src/routes/**/*.ts' },
    { name: 'testing', paths: '**/*.test.ts' },
    { name: 'style', paths: undefined },
  ]) {
    const frontmatter = rule.paths === undefined ? '' : `---\npaths: ${rule.paths}\n---\n\n`;
    writeAt(join(repo, '.claude', 'rules', `${rule.name}.md`), `${frontmatter}# ${rule.name}\n`);
  }
  writeJsonAt(join(repo, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
  });
  writeJsonAt(join(repo, '.claude', 'settings.local.json'), {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
  });
  writeJsonAt(join(repo, '.mcp.json'), {
    mcpServers: {
      linear: { command: 'npx', args: ['linear-mcp'], env: { LINEAR_API_KEY: 'lin_secret' } },
      shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] },
    },
  });
  return { repo, home };
}

/** A repository enabling the named harnesses and nothing else yet. */
function stageBare(
  tag: string,
  harnesses: string[],
  manifestExtras = {}
): {
  repo: string;
  home: string;
} {
  const { repo, home } = tempPair(tag);
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses,
    ...manifestExtras,
  });
  return { repo, home };
}

/** Install a project-scoped package under `.dork/plugins`, with the layers asked for. */
function stagePlugin(
  repo: string,
  name: string,
  parts: { layers: string[]; hooksJson?: string; command?: boolean }
): void {
  const plugin = join(repo, '.dork', 'plugins', name);
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'plugin',
    description: `The ${name} package`,
    layers: parts.layers,
  });
  writeSkill(join(plugin, 'skills', 'greet'), 'greet');
  if (parts.command === true) {
    writeAt(
      join(plugin, 'commands', 'hello.md'),
      '---\ndescription: Say hello\n---\n\nSay hello.\n'
    );
  }
  if (parts.hooksJson !== undefined) writeAt(join(plugin, 'hooks', 'hooks.json'), parts.hooksJson);
}

/**
 * Install a package of this name for every project, under the staged dork home.
 *
 * One `greet` skill unless the caller names others — the shape most cases want,
 * and the budget case wants five per package across twenty of them.
 */
function stageGlobalPlugin(
  home: string,
  name: string,
  skills: readonly string[] = ['greet']
): void {
  const plugin = join(home, 'plugins', name);
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name,
    version: '9.9.9',
    type: 'plugin',
    description: `The ${name} package`,
    layers: ['skills'],
  });
  for (const skill of skills) writeSkill(join(plugin, 'skills', skill), skill);
}

/**
 * A Claude-Code-only project with one plugin whose skill mentions
 * `${CLAUDE_PLUGIN_ROOT}`.
 *
 * Two placeholder harnesses meet in this one tree: the warning about the token
 * is emitted once per harness including Codex, and the unconditional
 * `.agents/skills` link is attributed to Codex too — neither of which this
 * project runs.
 */
function stagePluginRootSkill(): { repo: string; home: string } {
  const { repo, home } = stageBare('pluginroot', ['claude-code']);
  stagePlugin(repo, 'acme', { layers: ['skills'] });
  writeAt(
    join(repo, '.dork', 'plugins', 'acme', 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: The greet skill\n---\n\nRun ${CLAUDE_PLUGIN_ROOT}/bin/x\n'
  );
  return { repo, home };
}

describe('VC-01 — the status model derives eight states from five reads', () => {
  it('VC-01: J-01 derives 17 rows and 51 cells, with no enabled harness missing a cell', () => {
    // Seeded defect: a `rows: []` early return. Asserted first and on its own,
    // because such a return still satisfies every other case in this file.
    const { repo, home } = stageJ01();

    const status = statusOf(repo, home);

    expect(status.state).toBe('ready');
    expect(status.rows).toHaveLength(17);
    expect(allCells(status)).toHaveLength(51);
    for (const r of status.rows) {
      expect(Object.keys(r.cells).sort(), `cells of ${r.artifact}/${r.name}`).toEqual([
        'claude-code',
        'codex',
        'cursor',
      ]);
    }
    expect(rowsByArtifact(status)).toEqual({
      skill: 6,
      hook: 3,
      rule: 3,
      mcp: 2,
      command: 1,
      agent: 1,
      instruction: 1,
    });
    expect(dropsByHarness(status)).toEqual({ 'claude-code': 1, codex: 16, cursor: 9 });
    expect(status.counts).toEqual({
      skills: 6,
      // No package is installed for all projects on this fixture, so the global
      // half of the answer is empty and the project half is exactly what it was
      // before global rows existed.
      globalSkills: 0,
      drifted: 2,
      conflicts: 0,
      orphans: 0,
      adoptable: 6,
      pendingApproval: 0,
    });
    expect(status.enabled).toEqual(['claude-code', 'codex', 'cursor']);
    // Not because the field is missing — this tree simply holds no `.cursor/`,
    // `.codex/` or `.opencode/` footprint for detection to find.
    expect(status.notEnabled).toEqual([]);
    // This fixture installs no package, so the only project-level entry is the
    // read-time loss: `.claude/rules/testing.md` has frontmatter no reader can
    // parse, which happened before any harness was considered.
    expect(status.projectLevel).toEqual([
      {
        kind: 'warning',
        artifact: 'rule',
        name: '.claude/rules/testing.md',
        source: '.claude/rules/testing.md',
        reason:
          '.claude/rules/testing.md has frontmatter this reader cannot parse, so its "paths" globs were not read',
      },
    ]);
    expect(status.pendingApproval).toEqual([]);
    expect(status.clean).toBe(false);
    expect(status.sweepPreview).toEqual([]);
  });

  it('VC-01: the two MCP servers stay two rows, and the two settings-file hook groups stay two rows', () => {
    // Seeded defect: drop `name` from the row key and the two MCP servers, which
    // share `.mcp.json`, collapse into one. Drop `source` and the two hook groups,
    // both named `hooks`, collapse instead.
    const { repo, home } = stageJ01();

    const status = statusOf(repo, home);

    const mcp = status.rows.filter((r) => r.artifact === 'mcp');
    expect(mcp.map((r) => r.name).sort()).toEqual(['linear', 'shadcn']);
    expect(mcp.map((r) => r.source)).toEqual(['.mcp.json', '.mcp.json']);

    const settingsHooks = status.rows.filter((r) => r.artifact === 'hook' && r.name === 'hooks');
    expect(settingsHooks.map((r) => r.source).sort()).toEqual([
      '.claude/settings.json',
      '.claude/settings.local.json',
    ]);
    // And the third hook row is the one declared inside a skill's own frontmatter
    // — same source family, different artifact and name.
    expect(row(status, 'hook', '.claude/skills/release/SKILL.md', 'release')).toBeDefined();
  });

  it('VC-01: a Claude-only token warning rides the hook cell it already had, and forks no row', () => {
    // Seeded defect: key the warning by `(artifact, source, name)`. The generated
    // hooks action is named `hooks` and the warning is named after the EVENT, so
    // the full key stops matching and the warning becomes a second `hook` row —
    // one carrying a cell for `Stop` that no sync will ever act on, beside the
    // real row it belongs to.
    const { repo, home } = stageBare('annotate', ['claude-code', 'codex']);
    writeJsonAt(join(repo, '.claude', 'settings.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/guard.mjs' }] }],
      },
    });

    const status = statusOf(repo, home);

    const hooks = status.rows.filter((r) => r.artifact === 'hook');
    expect(hooks).toHaveLength(1);
    const projected = row(status, 'hook', '.claude/settings.json', 'hooks');
    expect(projected.cells['codex']?.state).toBe('drifted');
    expect(projected.cells['codex']?.warnings).toEqual([
      'hook command for "Stop" uses Claude-only "${CLAUDE_PLUGIN_ROOT}"; Codex will not resolve it, so this hook may not work',
    ]);
    // The warning names the event; no row is named after it.
    expect(status.rows.filter((r) => r.name === 'Stop')).toEqual([]);
    // And it annotates rather than replacing: Claude Code still reads the file.
    expect(projected.cells['claude-code']?.state).toBe('native');
  });

  it('VC-01: a .claude/skills skill is native for Claude Code and Cursor and dropped for Codex, with the reasons verbatim', () => {
    // Seeded defect: paraphrase one reason. The CLI prints these same strings, and
    // two surfaces describing one fact in two voices is how a person stops
    // trusting either.
    const { repo, home } = stageJ01();

    const status = statusOf(repo, home);

    const release = row(status, 'skill', '.claude/skills/release', 'release');
    expect(release.provenance).toBe('harness-native');
    expect(release.adoptable).toBe(true);
    expect(release.cells['claude-code']).toEqual({
      state: 'native',
      reason: `Claude Code reads .claude/skills directly ${CITED}`,
    });
    expect(release.cells['cursor']).toEqual({
      state: 'native',
      reason: `Cursor reads .claude/skills directly ${CITED}`,
    });
    expect(release.cells['codex']).toEqual({
      state: 'dropped',
      reason: `kept in .claude/skills, which Codex does not read ${CITED} — move it to .agents/skills to share it, or list it in manifest.claudeOnlySkills to say the Claude-only placement is deliberate`,
    });
  });

  it('VC-01: all six J-01 skills are adoptable, and on a tree whose skills are declared counts.adoptable is 0', () => {
    // Seeded defect: drop the `listed` exclusion. A `manifest.claudeOnlySkills`
    // entry is a person saying the placement is deliberate, and offering to undo it
    // argues with a decision that was written down.
    const j01 = stageJ01();
    const adoptable = statusOf(j01.repo, j01.home);
    expect(adoptable.counts.adoptable).toBe(6);
    expect(
      adoptable.rows
        .filter((r) => r.artifact === 'skill' && r.adoptable)
        .map((r) => r.name)
        .sort()
    ).toEqual([...J01_SKILLS]);

    const declared = stageBare('declared', ['claude-code', 'codex'], {
      claudeOnlySkills: [
        { name: 'foo', path: '.claude/skills/foo', reason: 'deliberately Claude-only' },
      ],
    });
    writeSkill(join(declared.repo, '.claude', 'skills', 'foo'), 'foo');

    const status = statusOf(declared.repo, declared.home);

    expect(row(status, 'skill', '.claude/skills/foo', 'foo').adoptable).toBe(false);
    expect(status.counts.adoptable).toBe(0);
    expect(status.counts.skills).toBe(1);
  });

  it('VC-01: a skill in both roots is not adoptable, and both rows appear', () => {
    // Seeded defect: drop the `alsoCanonical` exclusion, or dedupe rows by name.
    // The `.claude/skills` copy is a BLOCKER whose fix is a deletion, in the
    // projector's own words — calling it adoptable offers the one action that
    // makes it worse, and merging the two rows hides the copy that is in the way.
    const { repo, home } = stageBare('bothroots', ['claude-code', 'codex']);
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');
    writeSkill(join(repo, '.claude', 'skills', 'alpha'), 'alpha');

    const status = statusOf(repo, home);

    const canonical = row(status, 'skill', '.agents/skills/alpha', 'alpha');
    const copy = row(status, 'skill', '.claude/skills/alpha', 'alpha');
    expect(canonical.adoptable).toBe(false);
    expect(copy.adoptable).toBe(false);
    expect(status.counts.adoptable).toBe(0);
    // Two files, two rows, and the count under the profile row matches what the
    // page draws.
    expect(status.counts.skills).toBe(2);
    expect(copy.cells['codex']?.reason).toContain('remove it, or remove the canonical copy');
  });

  it('VC-01, XA-06: a skill in another tool’s own folder is a harness-native adoptable row', () => {
    // Seeded defect: keep `.claude/skills` as the only root that earns
    // `harness-native` and `adoptable`. An OpenCode-first team then gets a row
    // that claims their skill came from the canonical layer and offers no advice
    // about it, which is the silence DOR-1902 closed one directory over.
    const { repo, home } = stageBare('native-root', ['claude-code', 'opencode']);
    writeSkill(join(repo, '.opencode', 'skills', 'review-pr'), 'review-pr');

    const status = statusOf(repo, home);

    const skill = row(status, 'skill', '.opencode/skills/review-pr', 'review-pr');
    expect(skill.provenance).toBe('harness-native');
    expect(skill.adoptable).toBe(true);
    expect(skill.cells['opencode']).toEqual({
      state: 'native',
      reason: `OpenCode reads .opencode/skills directly ${CITED}`,
    });
    expect(skill.cells['claude-code']).toEqual({
      state: 'dropped',
      reason: `kept in .opencode/skills, where OpenCode looks and Claude Code does not ${CITED} — move it to .agents/skills to share it`,
    });
    expect(status.counts.adoptable).toBe(1);
  });

  it('VC-01, XA-07: another tool’s MCP config is one project-level drop and no row at all', () => {
    // Seeded defect: let it become a row. `adoptable` means "you could move this
    // into the canonical layer", and there is nowhere to move an `opencode.json`
    // to — the engine projects no MCP server anywhere yet. It is a fact about the
    // project, so it belongs beside the other project-level entries.
    const { repo, home } = stageBare('foreign-mcp', ['claude-code', 'opencode']);
    writeJsonAt(join(repo, 'opencode.json'), {
      mcp: { linear: { type: 'local', command: ['npx', 'linear-mcp'] } },
    });

    const status = statusOf(repo, home);

    expect(status.projectLevel).toEqual([
      {
        kind: 'drop',
        artifact: 'mcp',
        name: 'opencode.json',
        source: 'opencode.json',
        reason:
          'opencode.json declares 1 MCP server. DorkOS carries MCP servers from .mcp.json only, so the other tools do not get these.',
      },
    ]);
    expect(status.rows.filter((r) => r.source === 'opencode.json')).toEqual([]);
    expect(allCells(status).some((c) => c?.reason?.includes('opencode.json'))).toBe(false);
    // The server's name never leaves the file — the count is the whole read.
    expect(JSON.stringify(status)).not.toContain('linear');
  });

  it('VC-01: a harness-agnostic drop and a harness-agnostic warning both land in projectLevel and in no cell', () => {
    // Seeded defect: key project-level on `source === undefined`. The plugin-layer
    // drop carries no source and would still land right; the unreadable-hooks
    // warning DOES carry one and would become a `claude-code` cell — telling a
    // project that runs Codex alone that Claude Code has a problem.
    const { repo, home } = stageBare('agnostic', ['claude-code', 'codex']);
    stagePlugin(repo, 'acme', { layers: ['skills', 'hooks', 'mcp-servers'], hooksJson: '{ nope' });

    const status = statusOf(repo, home);

    expect(status.projectLevel).toEqual([
      {
        kind: 'drop',
        artifact: 'plugin',
        name: 'acme:mcp-servers',
        reason:
          'plugin layer "mcp-servers" is not a portable harness asset — MCP servers are configured per-harness, not projected as files',
      },
      {
        kind: 'warning',
        artifact: 'hook',
        name: 'acme:hooks',
        source: '.dork/plugins/acme/hooks/hooks.json',
        reason:
          '.dork/plugins/acme/hooks/hooks.json could not be read (invalid JSON, or a top level that is not an object), so every hook this package declares was dropped and none are projected',
      },
    ]);
    expect(status.rows.some((r) => r.name.startsWith('acme:'))).toBe(false);
    expect(allCells(status).some((c) => c?.reason?.includes('mcp-servers'))).toBe(false);
  });

  it('SRC-12: a package installed at both scopes earns one project-level notice, in no cell', () => {
    // Seeded defect: emit the notice per harness. It is a fact about the package
    // and the agent tools disagree about what it means, so a per-tool entry both
    // triples the line and files it under a heading that cannot be honest about
    // it. The engine flags it `harnessAgnostic`; this is the half of the claim
    // that the status model routes such an entry to `projectLevel` and to no cell.
    const { repo, home } = stageBare('bothscopes', ['claude-code', 'codex', 'cursor']);
    stagePlugin(repo, 'globex', { layers: ['skills'] });
    stageGlobalPlugin(home, 'globex');

    const status = statusOf(repo, home);

    const notices = status.projectLevel.filter((e) => e.reason.startsWith('is installed twice'));
    expect(notices).toEqual([
      {
        kind: 'drop',
        artifact: 'plugin',
        name: 'globex',
        reason:
          'is installed twice: once for all your projects, and once in this project. ' +
          'In a session DorkOS runs, Claude Code sees both copies, under different names. ' +
          "On its own, Claude Code sees only this project's copy. So does Codex, until you share it. " +
          'Uninstall one if you only meant to have one. ' +
          `Run dorkos uninstall globex --project ${repo}  to remove this project's copy. ` +
          'Run dorkos uninstall globex  to remove the all-projects copy. ' +
          'Both need DorkOS running, and both ask you first.',
      },
    ]);
    // Never a cell, and never a row: three tools run here and none of them is
    // what the line is about.
    expect(allCells(status).some((c) => c?.reason?.includes('installed twice'))).toBe(false);
    expect(status.rows.some((r) => r.name === 'globex')).toBe(false);
    // No version number, from either copy (the project one is 1.0.0, the global 9.9.9).
    expect(notices[0]?.reason).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('VC-01: a stale claudeOnlySkills entry is project-level even with Claude Code enabled', () => {
    // Seeded defect: drop `harnessAgnostic` from `planClaudeOnlySkills`'s warn.
    // The other stale-entry case enables only Codex, so the model's not-enabled
    // filter masks the missing flag; here Claude Code IS on and only the flag
    // decides. The subject is the MANIFEST — an entry that names nothing is wrong
    // whichever tools this project runs, and the person edits the same line.
    const { repo, home } = stageBare('staleon', ['claude-code', 'codex'], {
      claudeOnlySkills: [
        { name: 'ghost', path: '.claude/skills/ghost', reason: 'kept Claude-only' },
      ],
    });

    const status = statusOf(repo, home);

    expect(status.projectLevel).toContainEqual({
      kind: 'warning',
      artifact: 'skill',
      name: 'ghost',
      source: '.claude/skills/ghost',
      reason:
        'claudeOnlySkills entry is stale: no skill at .claude/skills/ghost, and none named "ghost" in .agents/skills',
    });
    expect(status.rows.filter((r) => r.name === 'ghost')).toEqual([]);
    expect(allCells(status).some((c) => c?.state === 'warned')).toBe(false);
  });

  it('VC-01: no cell is drawn for a harness the manifest does not enable', () => {
    // Seeded defect: drop the `enabled` check from pass 2 (`isAboutEnabledHarness`).
    // Three emitters hard-code a placeholder harness, and the last tree here is the
    // one that still does after the engine fix: the unconditional `.agents/skills`
    // link is attributed to `codex` whether or not codex is enabled, so its warning
    // names a harness this project has never run. Both readings of the resulting
    // cell are wrong and neither is loud — a renderer drawing the enabled columns
    // finds an empty row and the loss disappears; one drawing `Object.entries(cells)`
    // puts a Codex chip on a Claude-Code-only project.
    const cases: [string, string[], (repo: string) => void, string][] = [
      [
        'unreadable',
        ['opencode'],
        (repo) => writeAt(join(repo, '.mcp.json'), '{ this is not json'),
        '.mcp.json is not valid JSON',
      ],
      [
        'badrule',
        ['codex'],
        (repo) =>
          writeAt(
            join(repo, '.claude', 'rules', 'testing.md'),
            '---\npaths: **/*.test.ts\n---\n\n# t\n'
          ),
        'frontmatter this reader cannot parse',
      ],
      ['stale', ['codex'], () => undefined, 'claudeOnlySkills entry is stale'],
      [
        'pluginroot',
        ['claude-code'],
        (repo) => {
          stagePlugin(repo, 'acme', { layers: ['skills'] });
          writeAt(
            join(repo, '.dork', 'plugins', 'acme', 'skills', 'greet', 'SKILL.md'),
            '---\nname: greet\ndescription: The greet skill\n---\n\nRun ${CLAUDE_PLUGIN_ROOT}/bin/x\n'
          );
        },
        'only resolves in plugin context',
      ],
    ];

    for (const [tag, harnesses, stage, expected] of cases) {
      const extras =
        tag === 'stale'
          ? {
              claudeOnlySkills: [
                { name: 'ghost', path: '.claude/skills/ghost', reason: 'kept Claude-only' },
              ],
            }
          : {};
      const { repo, home } = stageBare(tag, harnesses, extras);
      stage(repo);

      const status = statusOf(repo, home);

      expect(status.enabled).toEqual(harnesses);
      // A floor first: an empty grid satisfies every subset check below.
      expect(status.rows.length, `${tag}: rows`).toBeGreaterThan(0);
      for (const r of status.rows) {
        const drawn = Object.keys(r.cells);
        expect(drawn.length, `${tag}: ${r.artifact}/${r.name} has no cell`).toBeGreaterThan(0);
        expect(
          drawn.filter((h) => !harnesses.includes(h)),
          `${tag}: ${r.artifact}/${r.name}`
        ).toEqual([]);
      }
      // And the loss is reported rather than dropped on the floor.
      const reasons = status.projectLevel.map((e) => e.reason);
      expect(
        reasons.some((r) => r.includes(expected)),
        `${tag}: ${reasons.join(' | ')}`
      ).toBe(true);
    }
  });

  it('VC-01: a plugin-root warning annotates its skill instead of forking a second row', () => {
    // Seeded defect: revert `source` on `pluginRootSkillWarning`. The warning
    // then matches no row and becomes a second `acme__greet` — one directory
    // drawn twice, above a count that agrees with the duplicate.
    const { repo, home } = stagePluginRootSkill();

    const status = statusOf(repo, home);

    expect(status.rows.filter((r) => r.artifact === 'skill')).toHaveLength(1);
    const skill = row(status, 'skill', '.dork/plugins/acme/skills/greet', 'acme__greet');
    expect(skill.cells['claude-code']?.warnings).toEqual([
      'skill SKILL.md references ${CLAUDE_PLUGIN_ROOT}, which only resolves in plugin context; the projected copy will not expand it',
    ]);
  });

  it('VC-01: one plugin skill is one row and one skill count', () => {
    // The number under the profile row has to match the number of rows the page
    // draws, and the duplicate above is exactly how the two come apart.
    const { repo, home } = stagePluginRootSkill();

    const status = statusOf(repo, home);

    expect(status.counts.skills).toBe(1);
    expect(status.counts.skills).toBe(status.rows.filter((r) => r.artifact === 'skill').length);
  });

  it('VC-01: a link a sync will write for a harness nobody enabled is still named', () => {
    // Seeded defect: stop routing unattributed writes to `projectLevel`. The
    // `.agents/skills` link exists for the directory rather than for one reader,
    // so the plan attributes it to Codex whether or not Codex is on — and on a
    // Claude-Code-only project it then appears in no column at all while a sync
    // creates the file. A preview that omits a file the click creates has the
    // same hole as one that omits a file the click deletes.
    const { repo, home } = stagePluginRootSkill();

    const status = statusOf(repo, home);

    expect(status.projectLevel).toContainEqual(
      expect.objectContaining({ kind: 'write', target: '.agents/skills/acme__greet' })
    );
    // And it is a project-level entry, not a Codex cell on a project without Codex.
    for (const r of status.rows) expect(Object.keys(r.cells)).toEqual(['claude-code']);
  });

  it('VC-01: a read-time loss is project-level even when its placeholder harness is enabled', () => {
    // Seeded defect: drop `harnessAgnostic` from `planInventoryWarnings`. With
    // claude-code enabled the model's own not-enabled filter cannot catch it, so
    // the loss becomes a Claude Code chip — and a `.mcp.json` that will not parse
    // reached NOBODY. It is a read-time failure, ahead of every harness, and the
    // engine's own module doc has always said so.
    const { repo, home } = stageBare('readtime', ['claude-code', 'codex']);
    writeAt(join(repo, '.mcp.json'), '{ this is not json');

    const status = statusOf(repo, home);

    expect(status.projectLevel).toEqual([
      {
        kind: 'warning',
        artifact: 'mcp',
        name: '.mcp.json',
        source: '.mcp.json',
        reason:
          ".mcp.json is not valid JSON (Expected property name or '}' in JSON at position 2 (line 1 column 3)), so nothing it declares was inventoried",
      },
    ]);
    expect(status.rows.filter((r) => r.artifact === 'mcp')).toEqual([]);
    expect(allCells(status).some((c) => c?.state === 'warned')).toBe(false);
  });

  it('VC-01: conflict outranks drifted — after a write, the same cell reads conflict', () => {
    // Seeded defect: swap rows 1-2 below row 4 in `deriveCell`, so a cell that is
    // both drifted and blocked reads `drifted`. The two mean opposite things to a
    // person — "re-run and it fixes itself" against "re-running will never fix
    // this" — and only the second changes what they do next.
    const { repo, home } = stageBare('precedence', ['claude-code', 'codex']);
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');

    // The target stays EMPTY, so `checkPlan` calls the cell drifted and nothing
    // else — the read half of the positive control. Staging an occupant instead
    // would make it `blocked`, `drifted` would be 0, and reordering the ladder
    // would red nothing.
    const beforeWrite = statusOf(repo, home);
    const drifted = row(beforeWrite, 'skill', '.agents/skills/alpha', 'alpha');
    expect(drifted.cells['claude-code']?.state).toBe('drifted');
    expect(beforeWrite.counts.drifted).toBe(1);
    expect(beforeWrite.counts.conflicts).toBe(0);

    // The write then reports the same cell as a conflict. Both facts are true of
    // it at once, and only one of them changes what the person does next.
    const conflictAction = {
      kind: 'symlink' as const,
      artifact: 'skill' as const,
      harness: 'claude-code' as const,
      provenance: 'authored' as const,
      name: 'alpha',
      source: '.agents/skills/alpha',
      target: '.claude/skills/alpha',
      reason: 'a real directory is in the way — move it and sync again',
    };

    const status = buildHarnessStatus({
      projectPath: repo,
      dorkHome: home,
      decisions: NO_DECISIONS,
      afterWrite: { conflicts: [conflictAction] },
    });

    const cell = row(status, 'skill', '.agents/skills/alpha', 'alpha').cells['claude-code'];
    expect(cell).toEqual({
      state: 'conflict',
      reason: 'a real directory is in the way — move it and sync again',
      target: '.claude/skills/alpha',
    });
    expect(status.counts.conflicts).toBe(1);
    expect(status.counts.drifted).toBe(0);
  });

  it('VC-01: counts.skills counts ROWS, not inventory entries', () => {
    // Seeded defect: count `inventory.skills.length`. A plugin's skill is a real
    // row on the page and is in nobody's source inventory — the inventory walks
    // what a person AUTHORED — so the number under the profile row would read 0
    // over a page drawing one.
    const { repo, home } = stageBare('rowcount', ['claude-code', 'codex']);
    stagePlugin(repo, 'acme', { layers: ['skills'] });

    const status = statusOf(repo, home);

    expect(status.counts.skills).toBe(1);
    expect(status.rows.filter((r) => r.artifact === 'skill')).toHaveLength(1);
    expect(row(status, 'skill', '.dork/plugins/acme/skills/greet', 'acme__greet').provenance).toBe(
      'installed'
    );
  });

  it('VC-01: a real directory at a symlink target is a conflict on a read', () => {
    // Seeded defect: revert the engine prerequisite (`findBlockedSymlinkTargets` in
    // `checkPlan`). `blocked` goes to 0, the cell reads `drifted`, and the banner
    // offers a sync that can never fix it.
    const { repo, home } = stageBare('conflict', ['claude-code', 'codex']);
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');
    // Somebody's own real directory exactly where the projection wants its link.
    writeSkill(join(repo, '.claude', 'skills', 'alpha'), 'alpha');

    const status = statusOf(repo, home);

    const canonical = row(status, 'skill', '.agents/skills/alpha', 'alpha');
    expect(canonical.cells['claude-code']?.state).toBe('conflict');
    expect(canonical.cells['claude-code']?.reason).toContain('blocked by a real directory');
    expect(status.counts.conflicts).toBe(1);
    expect(status.counts.drifted).toBe(0);
    expect(status.clean).toBe(false);
  });

  it('VC-01: a withheld package’s hooks are pending-approval, and no command text is in the response', () => {
    // Seeded defect: pass `request.hooks` through into the response. The approval
    // card is the surface built to show commands — redacted, capped, escaped — and
    // reproducing it here would mean reproducing four safety properties twice.
    const { repo, home } = stageBare('withheld', ['claude-code', 'codex']);
    stagePlugin(repo, 'acme', {
      layers: ['skills', 'hooks'],
      hooksJson: JSON.stringify({
        Stop: [{ hooks: [{ type: 'command', command: 'echo secret-acme-command' }] }],
      }),
    });

    const status = statusOf(repo, home);

    expect(status.pendingApproval).toEqual([
      { packageName: 'acme', events: ['Stop'], commandCount: 1, reason: 'unasked' },
    ]);
    expect(status.counts.pendingApproval).toBe(1);
    const held = row(status, 'hook', undefined, 'acme');
    expect(held.provenance).toBe('installed');
    expect(Object.keys(held.cells).sort()).toEqual(['claude-code', 'codex']);
    for (const cell of Object.values(held.cells)) {
      expect(cell?.state).toBe('pending-approval');
      expect(cell?.reason).toBe('acme wants to run commands. Approve it to share its hooks.');
    }
    expect(JSON.stringify(status)).not.toContain('secret-acme-command');
    expect(JSON.stringify(status)).not.toContain('echo ');
  });

  it('VC-01: a skill whose loading is undocumented for one harness is a warned cell, the row-8 shape J-01 cannot make', () => {
    // Seeded defect: make every warning an annotation. This warning names a cell
    // nothing else does — the plan has no action and no drop for Cursor, because
    // the vendor does not document whether it loads a skill whose frontmatter
    // name disagrees with its directory — so an annotation-only model leaves the
    // Cursor column blank and the person reads "fine" where the honest answer is
    // "nobody knows".
    const { repo, home } = stageBare('row8', ['claude-code', 'cursor']);
    // The directory says `alpha`, the frontmatter says `beta`.
    writeAt(
      join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'),
      '---\nname: beta\ndescription: The beta skill\n---\n\n# beta\n'
    );

    const status = statusOf(repo, home);

    // One row, not two: the warning joined the row Claude Code's action created.
    expect(status.rows.filter((r) => r.artifact === 'skill')).toHaveLength(1);
    const skill = row(status, 'skill', '.claude/skills/alpha', 'alpha');
    expect(skill.cells['cursor']?.state).toBe('warned');
    expect(skill.cells['cursor']?.reason).toContain('whether it loads this one is undocumented');
    // A state, not an annotation — nothing else named this cell.
    expect(skill.cells['cursor']?.warnings).toBeUndefined();
    // And the state is per harness: Claude Code keys skills by directory, which
    // is documented, so its own cell is settled.
    expect(skill.cells['claude-code']?.state).toBe('native');
  });

  it('VC-01: clean is false when only orphans exist, and sweepPreview names them', () => {
    // Seeded defect: compute `clean` from `drifted` and `blocked` while filtering
    // orphans out. Nothing drifts here and nothing is blocked, so that reading
    // calls a tree clean while the next sync deletes a file.
    const { repo, home } = stageBare('orphan', ['claude-code', 'codex']);
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');
    syncEverything(repo, home);
    rmSync(join(repo, '.agents', 'skills', 'alpha'), { recursive: true, force: true });

    const status = statusOf(repo, home);

    expect(status.counts.drifted).toBe(0);
    expect(status.counts.conflicts).toBe(0);
    expect(status.clean).toBe(false);
    expect(status.sweepPreview).toEqual(['.claude/skills/alpha']);
    expect(status.counts.orphans).toBe(1);
  });

  it('VC-01: an uninstalled plugin alone makes clean false, and sweepPreview names all nine of its paths', () => {
    // Seeded defect: revert Slice 2b, so `checkPlan().orphans` answers for one
    // sweep of six. `clean` reads `true` and the preview is empty while a click
    // deletes nine files — a warning with a hole in it, and the hole is where the
    // surprise lives.
    const { repo, home } = stageBare('sweep', ['claude-code', 'codex', 'opencode']);
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');
    stagePlugin(repo, 'acme', {
      layers: ['skills', 'hooks', 'commands'],
      command: true,
      hooksJson: JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }] }),
    });
    syncEverything(repo, home);
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const status = statusOf(repo, home);

    expect(status.counts.drifted).toBe(0);
    expect(status.clean).toBe(false);
    expect(status.sweepPreview).toEqual([
      '.agents/skills/acme__greet',
      '.claude/commands/acme/.gitignore',
      '.claude/commands/acme/hello.md',
      '.claude/settings.local.json',
      '.claude/skills/acme__greet',
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
      '.opencode/commands/.gitignore',
      '.opencode/commands/acme-hello.md',
    ]);
    expect(status.counts.orphans).toBe(9);
  });
});

describe('VC-01 — the envelope', () => {
  it('VC-01: the response round-trips its own Zod schema with nothing added or dropped', () => {
    // Seeded defect: add a field to the response that the schema does not declare.
    // `parse` strips it, so the equality below fails and the contract stays the
    // one thing both the route and the client can rely on.
    const { repo, home } = stageJ01();

    const status = statusOf(repo, home);

    expect(HarnessStatusResponseSchema.parse(status)).toEqual(status);
  });

  it('VC-01: a project with no manifest is not-set-up, one with a broken manifest is unreadable', () => {
    // Seeded defect: return `ready` with empty lists for either. A page cannot
    // tell "you have not set this up" from "everything is shared" if both arrive
    // as an empty grid.
    const { repo, home } = tempPair('states');

    const missing = statusOf(repo, home);
    expect(missing.state).toBe('not-set-up');
    expect(missing.detail).toBeUndefined();
    expect(missing.rows).toEqual([]);
    expect(missing.counts).toEqual({
      skills: 0,
      globalSkills: 0,
      drifted: 0,
      conflicts: 0,
      orphans: 0,
      adoptable: 0,
      pendingApproval: 0,
    });

    writeAt(join(repo, '.agents', 'harness.manifest.json'), '{ "version": 1, "harnesses": "all" }');
    const broken = statusOf(repo, home);
    expect(broken.state).toBe('unreadable');
    expect(broken.detail).toContain('.agents/harness.manifest.json');
    expect(broken.rows).toEqual([]);

    writeAt(join(repo, '.agents', 'harness.manifest.json'), 'not json at all');
    const unparseable = statusOf(repo, home);
    expect(unparseable.state).toBe('unreadable');
    expect(unparseable.detail).toContain('.agents/harness.manifest.json');
  });

  it('VC-01: a harness listed twice in the manifest is one column, not two', () => {
    // Seeded defect: `enabled = [...manifest.harnesses]`. `harnesses` is a plain
    // array in a hand-editable file, so a duplicate parses; left alone it draws the
    // chip twice and every count that walks the enabled list doubles with it.
    const { repo, home } = stageBare('dupes', ['codex', 'codex', 'claude-code', 'codex']);
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');

    const status = statusOf(repo, home);

    expect(status.enabled).toEqual(['codex', 'claude-code']);
    for (const r of status.rows) {
      expect(Object.keys(r.cells).length, `${r.artifact}/${r.name}`).toBeLessThanOrEqual(2);
    }
  });

  it('VC-01: what is wrong with the manifest itself reaches projectLevel as notices', () => {
    // DOR-1906. Seeded defect: drop the `manifestNotices` call and both lines
    // vanish from the payload while `dorkos harness sync` keeps printing them —
    // the terminal and the screen disagreeing about one file, which is the whole
    // thing VC-01 exists to stop. Seeded the other way — re-derive the retired
    // keys here instead of asking the engine — and the strings drift the day the
    // engine rewords one, which is why they are asserted verbatim.
    const { repo, home } = stageBare('notices', ['claude-code'], {
      skillWrappers: { deploy: { wrapper: '.claude/commands/deploy.md' } },
      hookPolicies: [{ tool: 'cursor', projection: 'none' }],
    });

    const notices = statusOf(repo, home).projectLevel.filter((e) => e.kind === 'notice');

    expect(notices).toEqual([
      {
        kind: 'notice',
        artifact: 'manifest',
        name: '.agents/harness.manifest.json',
        reason: 'skillWrappers in .agents/harness.manifest.json is no longer read — remove it',
      },
      {
        kind: 'notice',
        artifact: 'manifest',
        name: '.agents/harness.manifest.json',
        reason:
          'hookPolicies in .agents/harness.manifest.json names cursor, which this manifest does not enable',
      },
    ]);
  });

  it('VC-01: a manifest with nothing wrong with it produces no notices', () => {
    // The floor under the case above: without it, an implementation that emitted
    // a notice for every manifest — or one line per enabled harness — passes the
    // first test's `filter` and puts a permanent complaint on every project's
    // page. Seeded defect: drop `manifestNotices`' own guards.
    const { repo, home } = stageBare('notices-clean', ['claude-code', 'cursor'], {
      hookPolicies: [{ tool: 'cursor', projection: 'generate' }],
    });
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');

    const status = statusOf(repo, home);

    expect(status.state).toBe('ready');
    expect(status.projectLevel.filter((e) => e.kind === 'notice')).toEqual([]);
  });

  it('VC-01: computedAt is the instant of the read', () => {
    // Seeded defect: a fixed or lazily-cached timestamp. Bounded by two readings
    // taken around the call rather than compared against a later one, so a loaded
    // runner cannot turn this into a race.
    const { repo, home } = stageJ01();

    const before = Date.now();
    const status = statusOf(repo, home);
    const after = Date.now();

    const computed = Date.parse(status.computedAt);
    expect(Number.isNaN(computed)).toBe(false);
    expect(computed).toBeGreaterThanOrEqual(before - 1000);
    expect(computed).toBeLessThanOrEqual(after + 1000);
  });

  it('VC-01: buildHarnessStatus writes nothing — no path added, none removed, and no byte changed', () => {
    // Seeded defect: call `projectWithConsent` (or `applyPlan`) instead of
    // `planWithConsent`. The J-01 tree grows `.codex/hooks.json`,
    // `.cursor/hooks.json` and a pile of links, and a read has silently become a
    // write. The third tree is the one a path listing cannot see: a merge into a
    // `.claude/settings.local.json` that already exists changes its bytes and
    // adds no path at all.
    const j01 = stageJ01();
    expect(
      treeDiffWhile(j01.repo, () => expect(statusOf(j01.repo, j01.home).state).toBe('ready'))
    ).toEqual(NO_CHANGES);
    expect(treeDiffWhile(j01.home, () => statusOf(j01.repo, j01.home))).toEqual(NO_CHANGES);

    const bare = tempPair('nowrite');
    writeAt(join(bare.repo, 'CLAUDE.md'), '# nothing set up\n');
    expect(
      treeDiffWhile(bare.repo, () =>
        expect(statusOf(bare.repo, bare.home).state).toBe('not-set-up')
      )
    ).toEqual(NO_CHANGES);
    expect(treeDiffWhile(bare.home, () => statusOf(bare.repo, bare.home))).toEqual(NO_CHANGES);

    // A package whose hooks a person allowed, already synced: the next status is
    // the in-place-rewrite case, where the only evidence is content.
    const merged = stageBare('merge', ['claude-code', 'codex']);
    writeSkill(join(merged.repo, '.agents', 'skills', 'alpha'), 'alpha');
    stagePlugin(merged.repo, 'acme', {
      layers: ['skills', 'hooks'],
      hooksJson: JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }] }),
    });
    syncEverything(merged.repo, merged.home);
    expect(treeDiffWhile(merged.repo, () => statusOf(merged.repo, merged.home))).toEqual(
      NO_CHANGES
    );
  });
});

describe('VC-01 — packages installed for all projects are rows in every project’s answer', () => {
  it('VC-01: the same skill name at both scopes derives two rows, one per scope', () => {
    // Seeded defect: drop `scope` from the row. The two rows are then
    // indistinguishable to a reader, `counts.skills` counts both and
    // `counts.globalSkills` counts neither.
    const { repo, home } = stageBare('bothscopes', ['claude-code', 'codex']);
    stagePlugin(repo, 'globex', { layers: ['skills'] });
    stageGlobalPlugin(home, 'globex', ['greet']);

    const status = statusOf(repo, home);

    const named = status.rows.filter((r) => r.name === 'globex__greet');
    expect(named.map((r) => r.scope).sort()).toEqual(['global', 'project']);
    // Each keeps its own cells: the project copy is projected, the global copy
    // is dropped with the engine's own sentence about the package.
    const project = named.find((r) => r.scope === 'project');
    const global = named.find((r) => r.scope === 'global');
    expect(Object.keys(project?.cells ?? {}).sort()).toEqual(['claude-code', 'codex']);
    expect(Object.keys(global?.cells ?? {}).sort()).toEqual(['claude-code', 'codex']);
    expect(global?.cells['codex']?.state).toBe('dropped');
    expect(global?.cells['codex']?.reason).toContain('installed for all your projects');
    // And the source says which is which: repo-relative here, absolute there.
    expect(project?.source).toBe('.dork/plugins/globex/skills/greet');
    expect(global?.source).toBe(join(home, 'plugins', 'globex', 'skills', 'greet'));
  });

  it('VC-01: the row key tells two scopes apart when nothing else can', () => {
    // Seeded defect: drop `scope` from `harnessRowKey`. On real trees the two
    // sources differ — one repo-relative, one absolute — so no fixture can make
    // the collapse happen end to end; this is where the fourth component is
    // actually load-bearing, and where removing it reds.
    const entry = { artifact: 'skill', source: '/x/skills/greet', name: 'globex__greet' } as const;
    expect(harnessRowKey({ ...entry, scope: 'project' })).not.toEqual(
      harnessRowKey({ ...entry, scope: 'global' })
    );
    // Absent means project, matching the schema default, so nothing that
    // predates global scope changes key.
    expect(harnessRowKey(entry)).toEqual(harnessRowKey({ ...entry, scope: 'project' }));
  });

  it('VC-01: counts.skills counts project rows only, and globalSkills counts the rest', () => {
    const { repo, home } = stageBare('counts', ['claude-code', 'codex']);
    writeSkill(join(repo, '.agents', 'skills', 'alpha'), 'alpha');
    stageGlobalPlugin(home, 'globex', ['greet', 'wave']);

    const status = statusOf(repo, home);

    expect(status.counts.globalSkills).toBe(2);
    expect(status.counts.skills).toBe(
      status.rows.filter((r) => r.artifact === 'skill' && r.scope === 'project').length
    );
    // Disjoint by definition: their sum is every skill row the page draws.
    expect(status.counts.skills + status.counts.globalSkills).toBe(
      status.rows.filter((r) => r.artifact === 'skill').length
    );
  });

  it('VC-01: a project with no manifest still answers with what is installed for all projects', () => {
    // The point of the fold: this folder not being set up says nothing about
    // whether somebody installed a package for every project.
    const { repo, home } = tempPair('notsetup-global');
    stageGlobalPlugin(home, 'globex', ['greet']);

    const status = statusOf(repo, home);

    expect(status.state).toBe('not-set-up');
    expect(status.counts.globalSkills).toBe(1);
    expect(status.rows.map((r) => ({ name: r.name, scope: r.scope, cells: r.cells }))).toEqual([
      // No enabled tool, so no cell to put a sentence in: the row is the answer.
      { name: 'globex__greet', scope: 'global', cells: {} },
    ]);
  });

  it('VC-01: the whole answer stays inside its byte budget with the global fold', () => {
    // DOR-1852 set the budget at 250 KB and measured 32,415 bytes for this
    // repository. The budget now INCLUDES global rows, so it is re-measured here
    // against the planning ceiling that spec named: 20 packages of 5 skills.
    const { repo, home } = stageBare('budget', ['claude-code', 'codex', 'cursor']);
    for (let i = 0; i < 20; i++) {
      stageGlobalPlugin(home, `package-${String(i).padStart(2, '0')}`, [
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
      ]);
    }

    const status = statusOf(repo, home);
    const bytes = Buffer.byteLength(JSON.stringify(status), 'utf8');

    expect(status.counts.globalSkills).toBe(100);
    // Measured on this fixture: 92,254 bytes — 100 global rows over three
    // enabled tools, beside a project half with one authored skill. The
    // counterexample carries the number, so a regression says how far past it went.
    expect({ bytes: bytes <= 250 * 1024, measured: bytes }).toEqual({
      bytes: true,
      measured: bytes,
    });
  });
});

describe('VC-01 — what is true about the machine rather than about a tool', () => {
  const realPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  /**
   * A Windows checkout whose skill links are junctions.
   *
   * Staged as what a junction IS on disk — a link whose stored target is
   * absolute — with `process.platform` redefined, which is how the engine's own
   * suite drives this shape from a POSIX machine
   * (`apply/__tests__/windows-links.test.ts`).
   */
  function stageJunctionCheckout(): { repo: string; home: string } {
    const { repo, home } = stageBare('junction', ['claude-code']);
    const source = join(repo, '.agents', 'skills', 'demo');
    mkdirSync(source, { recursive: true });
    writeSkill(source, 'demo');
    mkdirSync(join(repo, '.claude', 'skills'), { recursive: true });
    symlinkSync(source, join(repo, '.claude', 'skills', 'demo'));
    mkdirSync(join(repo, '.git'), { recursive: true });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    return { repo, home };
  }

  it('VC-01, AP-06: a junction a person must not commit is a project-level warning, once', () => {
    // Seeded defect: leave `checkPlan().warnings` out of `projectLevelEntries`.
    // The page then shows a tree that looks perfectly synced while `git add`
    // would commit the skill's files instead of the link (DOR-1883).
    const { repo, home } = stageJunctionCheckout();

    const status = statusOf(repo, home);

    expect(status.projectLevel).toContainEqual({
      kind: 'warning',
      artifact: 'skill',
      name: 'Windows junctions',
      reason: JUNCTION_COMMIT_WARNING,
    });
    // It is about the machine, so it belongs to no tool's column — and it is
    // not a fault: nothing is drifted, nothing is blocked, the tree is clean.
    expect(status.clean).toBe(true);
    expect(status.counts.conflicts).toBe(0);
  });

  it('VC-01, AP-06: says nothing on a checkout whose links are real', () => {
    const { repo, home } = stageJunctionCheckout();
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });

    const status = statusOf(repo, home);

    expect(status.projectLevel.map((entry) => entry.reason)).not.toContain(JUNCTION_COMMIT_WARNING);
  });
});
