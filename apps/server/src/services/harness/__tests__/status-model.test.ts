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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HarnessStatusResponseSchema } from '@dorkos/shared/harness-schemas';
import type { HarnessCell, HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { hookApprovalEntry, type HookDecisions } from '../hook-consent.js';
import { projectWithConsent, scanHookRequests } from '../project-with-consent.js';
import { buildHarnessStatus } from '../status.js';

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

/** Every path under a root, directories marked `/` and symlinks `@`, sorted. */
function pathSet(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) out.push(`${path}@`);
      else if (entry.isDirectory()) {
        out.push(`${path}/`);
        walk(join(dir, entry.name), path);
      } else out.push(path);
    }
  };
  walk(root, '');
  return out.sort();
}

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
    // This fixture installs no package, so nothing in it is harness-agnostic.
    expect(status.projectLevel).toEqual([]);
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

  it('VC-01: the unparseable rule’s warning rides the claude-code cell it already had, and forks no row', () => {
    // Seeded defect: key the warning by `(artifact, source, name)`. The warning is
    // named after the FILE and the action after the RULE, so it stops matching and
    // becomes a second `rule` row holding one cell and two holes.
    const { repo, home } = stageJ01();

    const status = statusOf(repo, home);

    expect(status.rows.filter((r) => r.artifact === 'rule')).toHaveLength(3);
    const testing = row(status, 'rule', '.claude/rules/testing.md', 'testing');
    expect(Object.keys(testing.cells).sort()).toEqual(['claude-code', 'codex', 'cursor']);
    expect(testing.cells['claude-code']?.state).toBe('native');
    expect(testing.cells['claude-code']?.warnings).toEqual([
      '.claude/rules/testing.md has frontmatter this reader cannot parse, so its "paths" globs were not read',
    ]);
    expect(status.rows.filter((r) => r.name === '.claude/rules/testing.md')).toEqual([]);
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

  it('VC-01: a source the inventory could not read produces a warned cell, the row-8 shape J-01 cannot make', () => {
    // Seeded defect: make every warning an annotation. This warning names a cell
    // nothing else does — the servers it would have described were never read — so
    // an annotation-only model draws no row at all and the loss is silent, which
    // is the exact failure the inventory exists to end.
    const { repo, home } = stageBare('row8', ['claude-code', 'codex']);
    writeAt(join(repo, '.mcp.json'), '{ this is not json');

    const status = statusOf(repo, home);

    const unreadable = row(status, 'mcp', '.mcp.json', '.mcp.json');
    expect(unreadable.provenance).toBe('authored');
    expect(unreadable.cells['claude-code']?.state).toBe('warned');
    expect(unreadable.cells['claude-code']?.reason).toContain('.mcp.json is not valid JSON');
    // Nothing else names this cell, so it is a state rather than an annotation.
    expect(unreadable.cells['claude-code']?.warnings).toBeUndefined();
    // And the warning is about one harness's reader, so it forges no codex cell.
    expect(unreadable.cells['codex']).toBeUndefined();
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

  it('VC-01: buildHarnessStatus writes nothing, on a set-up project and on one with no manifest', () => {
    // Seeded defect: call `projectWithConsent` (or `applyPlan`) instead of
    // `planWithConsent`. The J-01 tree grows `.codex/hooks.json`, `.cursor/hooks.json`
    // and a pile of links, and a read has silently become a write.
    const j01 = stageJ01();
    const repoBefore = pathSet(j01.repo);
    const homeBefore = pathSet(j01.home);

    expect(statusOf(j01.repo, j01.home).state).toBe('ready');

    expect(pathSet(j01.repo)).toEqual(repoBefore);
    expect(pathSet(j01.home)).toEqual(homeBefore);

    const bare = tempPair('nowrite');
    writeAt(join(bare.repo, 'CLAUDE.md'), '# nothing set up\n');
    const bareBefore = pathSet(bare.repo);

    expect(statusOf(bare.repo, bare.home).state).toBe('not-set-up');

    expect(pathSet(bare.repo)).toEqual(bareBefore);
    expect(pathSet(bare.home)).toEqual([]);
  });
});
