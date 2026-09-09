/**
 * J-03 — an existing OpenCode project adopts DorkOS.
 *
 * The tree is a real OpenCode repository and nothing else: a root `AGENTS.md`,
 * two skills as real directories in `.opencode/skills/`, an authored slash
 * command in `.opencode/commands/`, and an `opencode.json` carrying an MCP
 * server. No `.claude/`, no `.agents/`.
 *
 * The contract's J-03 row (`meta/harness-sync-capabilities.md` §12) makes three
 * claims about that tree, and this journey measures all three as exact tree
 * diffs. All three hold:
 *
 * - **Commands are safe.** Ownership of a file under `.opencode/commands` is a
 *   MARKER in the file, never the directory it sits in, so a person's own
 *   `deploy.md` survives every sync and every sweep beside the wrappers the
 *   engine generates there (CM-03).
 * - **The pointer is scaffolded.** With Claude Code enabled, the one thing the
 *   first sync writes is `.claude/CLAUDE.md` pointing at their `AGENTS.md`, so a
 *   DorkOS-managed Claude Code session reads the instructions they already have
 *   (IN-01).
 * - **The two kinds this team actually has are named.** `.opencode/skills/*` is
 *   read where it sits by OpenCode and an honest drop for Claude Code, naming the
 *   folder they really use; `opencode.json`'s MCP servers are one project-level
 *   drop saying how many there are and that DorkOS carries MCP servers from
 *   `.mcp.json` only. The last `it` in this file used to PIN the opposite as a
 *   negative — both reaching no list at all, because the inventory's roots were
 *   Claude-shaped — and DOR-1902 turned it into the positive assertion the row
 *   describes, with an exact tree diff proving that reporting both wrote nothing.
 *
 * The first `it` used to pin a FOURTH finding as a negative: detection enables
 * the harnesses whose files are on disk, and this tree has none of Claude
 * Code's, so the manifest came out `codex, opencode` and the pointer the row
 * promises was never written by the path a person actually takes. DOR-1901
 * closed it. `scaffoldManifest` now takes the harness DorkOS's own default
 * runtime reads as an injected input and adds it to whatever detection found,
 * so the scaffold is `codex, opencode, claude-code` — detection's answer, then
 * the one the folder could not show — and the first sync writes the pointer.
 * That test is now the POSITIVE assertion the row describes.
 *
 * Rows: J-03, IN-01 (the instruction pointer), CM-03 (repo-local command
 * wrappers), AP-07 (the sweep only ever deletes what it wrote), and XA-06 /
 * XA-07 for the two kinds that used to be silent. Those two needed §8 rows of
 * their own rather than an existing id: SK-13 is about a symlinked or `__`-named
 * source and XA-03 about `.mcp.json`, and neither is what another tool's own
 * skills folder or an `opencode.json` `mcp` block is.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import { scaffoldManifest } from '../../scaffold/manifest.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { diffSnapshots, readText, snapshotTree } from './stage.js';
import { stageRepo, type StageRepoSpec, type StagedRepo } from './stage-repo.js';

/** The two skills this team keeps where OpenCode reads them. */
const OPENCODE_SKILLS = ['review-pr', 'ship'] as const;

/** Their own slash command, authored by hand — not a wrapper the engine wrote. */
const AUTHORED_COMMAND = '.opencode/commands/deploy.md';

/** The MCP server their `opencode.json` declares. */
const OPENCODE_JSON = {
  $schema: 'https://opencode.ai/config.json',
  mcp: { linear: { type: 'local', command: ['npx', 'linear-mcp'] } },
};

let staged: StagedRepo | undefined;

afterEach(() => {
  staged?.cleanup();
  staged = undefined;
});

/**
 * Stage the OpenCode-first repository.
 *
 * @param overrides - extra spec merged over the base tree (a manifest, a plugin).
 * @returns the staged repository.
 */
function stageOpenCodeRepo(overrides: StageRepoSpec = {}): StagedRepo {
  staged = stageRepo({
    manifest: false,
    agents: { agentsMd: true },
    opencode: {
      skills: [...OPENCODE_SKILLS],
      commands: ['deploy'],
      opencodeJson: OPENCODE_JSON,
    },
    ...overrides,
  });
  return staged;
}

/** The plan for a staged repository as it stands right now. */
function plan(repo: StagedRepo): ProjectionPlan {
  return project(repo.root, { dorkHome: repo.dorkHome });
}

/** Every line the report says about one repo-relative source path, in any list. */
function linesAbout(p: ProjectionPlan, source: string): string[] {
  return [
    ...[...p.actions, ...p.drops]
      .filter((a) => a.source?.startsWith(source))
      .map((a) => `${a.kind} ${a.artifact} ${a.name}`),
    ...p.warnings.filter((w) => w.source?.startsWith(source)).map((w) => `warning ${w.name}`),
  ].sort();
}

describe('J-03 — an OpenCode project adopts DorkOS', () => {
  it('J-03, IN-01, TR-11: the tool DorkOS runs is enabled here, and the pointer lands', () => {
    const repo = stageOpenCodeRepo();
    const before = snapshotTree(repo.root);
    // The fixture is a real repository, not an empty directory — without this
    // the exact diff below would be "nothing happened to nothing". Spelled as
    // the whole path list because that is also the clearest statement of what
    // an OpenCode-first repo holds before DorkOS touches it.
    expect([...before.keys()].sort()).toEqual([
      '.opencode',
      '.opencode/commands',
      '.opencode/commands/deploy.md',
      '.opencode/skills',
      '.opencode/skills/review-pr',
      '.opencode/skills/review-pr/SKILL.md',
      '.opencode/skills/ship',
      '.opencode/skills/ship/SKILL.md',
      'AGENTS.md',
      'opencode.json',
    ]);

    // This is the path a person actually takes: DorkOS scaffolds the manifest
    // for a project it has just been pointed at, and it knows one thing the
    // folder cannot show it — the agent tool its own sessions run on.
    const scaffold = scaffoldManifest(repo.root, { dorkosHarness: 'claude-code' });

    // Codex because `AGENTS.md` is its instruction file, OpenCode because
    // `.opencode/` is on disk — detection's own answer, in its own order — and
    // then Claude Code, appended because DorkOS runs it here and nothing in this
    // tree could have said so. The row's `opencode` + `claude-code` was right
    // about the outcome and wrong about how the set is reached.
    expect(scaffold.harnesses).toEqual(['codex', 'opencode', 'claude-code']);
    expect(scaffold.detected).toBe(true);
    expect(scaffold.addedForDorkos).toBe('claude-code');

    const { conflicts } = applyPlan(repo.root, plan(repo), { sweepOrphans: true });

    // The whole first sync: the manifest, and the pointer. Nothing else — the
    // two OpenCode kinds this journey is still silent about are the last `it`.
    expect(conflicts).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: ['.agents', '.agents/harness.manifest.json', '.claude', '.claude/CLAUDE.md'],
      changed: [],
      removed: [],
    });
    // A pointer, not a copy: their own AGENTS.md stays the one file they edit,
    // and a DorkOS Claude Code session in this repo now reads it (IN-01).
    expect(readText(join(repo.root, '.claude', 'CLAUDE.md'))).toBe('@../AGENTS.md\n');
  });

  it('J-03, TR-11: a manifest written before this says so, and says how to fix it', () => {
    // The other half of the same gap. An existing manifest is the person's file
    // and detection never rewrites it (ADR-302), so a project set up before
    // DOR-1901 keeps a harness set with no Claude Code in it — and nothing on
    // disk is Claude Code's, so the footprint notice cannot fire. The plan says
    // it anyway, from the one fact the tree cannot show.
    const repo = stageOpenCodeRepo({ manifest: { harnesses: ['codex', 'opencode'] } });
    const before = snapshotTree(repo.root);
    const manifestPath = join(repo.root, '.agents', 'harness.manifest.json');
    const manifestBefore = readText(manifestPath);

    expect(project(repo.root, { dorkHome: repo.dorkHome }).notEnabled).toEqual([]);
    expect(
      project(repo.root, { dorkHome: repo.dorkHome, dorkosHarness: 'claude-code' }).notEnabled
    ).toEqual([{ harness: 'claude-code', why: 'dorkos-runtime' }]);

    // Reporting only. The manifest is the person's file (ADR-302), so the claim
    // is byte equality rather than "it still parses the same" — a re-serialized
    // manifest with their spacing rewritten is exactly the harm that rule names.
    expect(readText(manifestPath)).toBe(manifestBefore);
    // And nothing anywhere else, either: `.claude/` is what a fix would write.
    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(existsSync(join(repo.root, '.claude'))).toBe(false);
  });

  it('J-03, IN-01: with Claude Code enabled, the whole first sync is one pointer file', () => {
    const repo = stageOpenCodeRepo({ manifest: { harnesses: ['claude-code', 'opencode'] } });
    const before = snapshotTree(repo.root);

    const { conflicts } = applyPlan(repo.root, plan(repo), { sweepOrphans: true });

    expect(conflicts).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: ['.claude', '.claude/CLAUDE.md'],
      changed: [],
      removed: [],
    });
    // A pointer, not a copy: their AGENTS.md stays the one file they edit.
    expect(readText(join(repo.root, '.claude', 'CLAUDE.md'))).toContain('AGENTS.md');
    expect(checkPlan(repo.root, plan(repo)).clean).toBe(true);
  });

  it('J-03, CM-03, AP-07: an authored .opencode command outlives the wrappers beside it', () => {
    const repo = stageOpenCodeRepo({
      manifest: { harnesses: ['claude-code', 'opencode'] },
      plugins: [{ name: 'flow', scope: 'project', skills: ['drain'], commands: ['capture'] }],
    });
    const authored = readText(join(repo.root, AUTHORED_COMMAND));
    const before = snapshotTree(repo.root);

    expect(applyPlan(repo.root, plan(repo), { sweepOrphans: true }).conflicts).toEqual([]);

    // The install writes into the same directory their own command lives in.
    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: [
        '.agents/skills',
        '.agents/skills/flow__drain',
        '.claude',
        '.claude/CLAUDE.md',
        '.claude/skills',
        '.claude/skills/flow__drain',
        '.claude/commands',
        '.claude/commands/flow',
        '.claude/commands/flow/.gitignore',
        '.claude/commands/flow/capture.md',
        '.opencode/commands/.gitignore',
        '.opencode/commands/flow-capture.md',
      ].sort(),
      changed: [],
      removed: [],
    });

    // Uninstall: everything the engine wrote into that directory goes, and the
    // person's own file is not even considered — ownership is the marker in the
    // file, never the directory.
    const afterInstall = snapshotTree(repo.root);
    rmSync(join(repo.root, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    applyPlan(repo.root, plan(repo), { sweepOrphans: true });

    expect(diffSnapshots(afterInstall, snapshotTree(repo.root))).toEqual({
      added: [],
      changed: [],
      removed: [
        // The person's own `rm -rf` of the package directory…
        '.dork/plugins/flow',
        '.dork/plugins/flow/.dork',
        '.dork/plugins/flow/.dork/manifest.json',
        '.dork/plugins/flow/commands',
        '.dork/plugins/flow/commands/capture.md',
        '.dork/plugins/flow/skills',
        '.dork/plugins/flow/skills/drain',
        '.dork/plugins/flow/skills/drain/SKILL.md',
        // …and everything the engine had written for it, swept.
        '.agents/skills/flow__drain',
        // The namespaced wrapper dir goes with the last wrapper in it; the
        // shared `.opencode/commands` does not, because their own file is there.
        '.claude/commands/flow',
        '.claude/commands/flow/.gitignore',
        '.claude/commands/flow/capture.md',
        '.claude/skills/flow__drain',
        '.opencode/commands/.gitignore',
        '.opencode/commands/flow-capture.md',
      ].sort(),
    });
    expect(readText(join(repo.root, AUTHORED_COMMAND))).toBe(authored);
  });

  it('J-03, XA-06, XA-07: the two kinds this team actually has are named, and reporting them writes nothing', () => {
    // THE GAP, CLOSED (DOR-1902). This case used to PIN the silence as a negative
    // — `.opencode/skills/*` and `opencode.json` reaching no action, no drop and
    // no warning, because the inventory walked `.agents/skills` and
    // `.claude/skills` only and read MCP servers out of `.mcp.json` only. It is
    // now the positive assertion the contract's J-03 row describes.
    const repo = stageOpenCodeRepo({ manifest: { harnesses: ['claude-code', 'opencode'] } });
    const before = snapshotTree(repo.root);
    const p = plan(repo);

    // Zero-subject guard: the plan does say something about the rest of this tree
    // too, so what follows is a statement about these two and not about a plan
    // that came back full of everything.
    expect(linesAbout(p, 'AGENTS.md')).toEqual([
      'native instruction AGENTS.md',
      'scaffold instruction AGENTS.md',
    ]);

    // Their two skills: read where they are by the tool that reads that folder,
    // and an honest drop for the one that does not — with the folder they are
    // actually in named, not `.claude/skills`.
    for (const skill of OPENCODE_SKILLS) {
      expect(linesAbout(p, `.opencode/skills/${skill}`)).toEqual([
        `drop skill ${skill}`,
        `native skill ${skill}`,
      ]);
    }
    const reasons = [...p.actions, ...p.drops]
      .filter((a) => a.source === '.opencode/skills/review-pr')
      .map((a) => `${a.harness}: ${a.reason ?? ''}`)
      .sort();
    expect(reasons).toEqual([
      'claude-code: kept in .opencode/skills, where OpenCode looks and Claude Code does not (vendor docs, 2026-09-07) — move it to .agents/skills to share it',
      'opencode: OpenCode reads .opencode/skills directly (vendor docs, 2026-09-07)',
    ]);

    // Their MCP server: one project-level drop naming the file and the count,
    // never the server and never a value.
    expect(linesAbout(p, 'opencode.json')).toEqual(['drop mcp opencode.json']);
    expect(p.drops.find((d) => d.source === 'opencode.json')).toEqual({
      kind: 'drop',
      artifact: 'mcp',
      harness: 'claude-code',
      harnessAgnostic: true,
      provenance: 'authored',
      name: 'opencode.json',
      source: 'opencode.json',
      reason:
        'opencode.json declares 1 MCP server. DorkOS carries MCP servers from .mcp.json only, so the other tools do not get these.',
    });
    expect(JSON.stringify([p.actions, p.drops, p.warnings])).not.toContain('linear');

    // And saying all of that changed nothing on disk: adopt is report-only (§16
    // D3) and no MCP server is projected anywhere yet (XA-03). The only thing a
    // `--fix` writes here is still the pointer, which the case above measures.
    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });
});
