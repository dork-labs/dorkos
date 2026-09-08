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
 * diffs. Two of them hold today and one does not:
 *
 * - **Commands are safe.** Ownership of a file under `.opencode/commands` is a
 *   MARKER in the file, never the directory it sits in, so a person's own
 *   `deploy.md` survives every sync and every sweep beside the wrappers the
 *   engine generates there (CM-03).
 * - **The pointer is scaffolded.** With Claude Code enabled, the one thing the
 *   first sync writes is `.claude/CLAUDE.md` pointing at their `AGENTS.md`, so a
 *   DorkOS-managed Claude Code session reads the instructions they already have
 *   (IN-01).
 * - **It is silent about two kinds.** `.opencode/skills/*` and `opencode.json`
 *   reach no action, no drop and no warning — the row's own words, still true.
 *   The last `it` in this file pins that silence rather than asserting the
 *   contract's expectation, because a red suite is not a way to record a gap:
 *   when the inventory learns those two roots, that test fails and its
 *   replacement is the positive assertion the row describes.
 *
 * There is a fourth finding this journey turned up, and it is the reason the
 * first `it` exists: detection never enables Claude Code for this tree, so the
 * pointer the row promises is never scaffolded by the path a person actually
 * takes. The row assumes a manifest of `opencode` + `claude-code`; the engine
 * scaffolds `codex` + `opencode`, because it enables the harnesses whose files
 * are on disk and DorkOS's own harness has left none there yet.
 *
 * Rows: J-03, IN-01 (the instruction pointer), CM-03 (repo-local command
 * wrappers), AP-07 (the sweep only ever deletes what it wrote). The two
 * silences get no row id on purpose: SK-13 is about a symlinked or `__`-named
 * source and XA-03 about `.mcp.json`, and neither is what a harness-native
 * skills root nobody reads or an `opencode.json` `mcp` block is. §8 is where a
 * row for them would go.
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
  it('J-03: detection enables the harnesses whose files are here, and writes nothing', () => {
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

    const scaffold = scaffoldManifest(repo.root);

    // Codex because `AGENTS.md` is its instruction file, OpenCode because
    // `.opencode/` is on disk. NOT `claude-code`: the contract's J-03 row assumes
    // `opencode` + `claude-code`, and nothing in this tree is Claude Code's, so
    // detection has nothing to go on. The consequence is the next assertion —
    // the `.claude/CLAUDE.md` pointer the row promises never gets written by the
    // path a person actually takes. Recorded, not endorsed: closing it is a
    // decision about whether DorkOS's own harness is always enabled, which
    // belongs to the detection row (TR-11), not to a test.
    expect(scaffold.harnesses).toEqual(['codex', 'opencode']);
    expect(scaffold.detected).toBe(true);

    const { conflicts } = applyPlan(repo.root, plan(repo), { sweepOrphans: true });

    expect(conflicts).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: ['.agents', '.agents/harness.manifest.json'],
      changed: [],
      removed: [],
    });
    expect(existsSync(join(repo.root, '.claude', 'CLAUDE.md'))).toBe(false);
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

  it('J-03: pins the two kinds this journey is still silent about', () => {
    // THE GAP, PINNED. The contract's J-03 row says `.opencode/skills/*` should be
    // reported adoptable and `opencode.json` should be reported rather than
    // clobbered; the inventory walks `.agents/skills` and `.claude/skills` only
    // (`inventory/types.ts` `SkillRoot`) and reads MCP servers out of `.mcp.json`
    // only, so both are absent from every list the report prints.
    //
    // This asserts the silence rather than the expectation on purpose: the fix is
    // an inventory change, not a test change, and a suite that ships red records
    // nothing. When that fix lands this test goes red — replace it with the
    // positive assertion the row describes, which is the whole point of it being
    // here.
    const repo = stageOpenCodeRepo({ manifest: { harnesses: ['claude-code', 'opencode'] } });
    const p = plan(repo);

    // Zero-subject guard: the plan does say something about this tree, so
    // "nothing about these two" is a statement about them and not about a plan
    // that came back empty.
    expect(linesAbout(p, 'AGENTS.md')).toEqual([
      'native instruction AGENTS.md',
      'scaffold instruction AGENTS.md',
    ]);

    for (const skill of OPENCODE_SKILLS) {
      expect(linesAbout(p, `.opencode/skills/${skill}`)).toEqual([]);
    }
    expect(linesAbout(p, 'opencode.json')).toEqual([]);
    // …and nothing names either root by any other route, either.
    const everything = JSON.stringify([p.actions, p.drops, p.warnings]);
    expect(everything).not.toContain('.opencode/skills');
    expect(everything).not.toContain('opencode.json');
  });
});
