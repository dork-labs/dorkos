/**
 * J-02 — an existing Codex project adopts DorkOS.
 *
 * The repo is somebody else's: `AGENTS.md`, four skills in `.agents/skills/`, a
 * hand-written `.codex/hooks.json`, a hand-written `.cursor/hooks.json`, a
 * hand-written `.github/hooks/copilot-hooks.json` for a Copilot cloud agent the
 * team also runs, and a `.codex/config.toml`. There is no `.claude/` anywhere, so
 * manifest detection enables `codex` and `cursor` — and NOT copilot.
 *
 * Then a person installs a marketplace plugin from the app. That runs the same
 * project + apply-with-sweep pass `runAutoProjection` runs, whose first pass has
 * no hook contributors by design (the DOR-522 consent card has not been raised
 * yet). The engine must add the plugin's skill link and touch NOTHING else: all
 * three hand-written hooks files survive byte-for-byte, and each is named as a
 * conflict so the person is told how to bring their hooks under DorkOS.
 *
 * The exact-diff assertion is the seeded defect: before DOR-1842 the sweep
 * deleted all three files (the Copilot one for a harness the manifest never
 * enabled), so `removed` held three paths instead of none.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import { scaffoldManifest } from '../../scaffold/manifest.js';
import { diffSnapshots, readText, snapshotTree, writeFileAt, writeJsonAt } from './stage.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** The three hooks files this team wrote by hand, keyed by repo-relative path. */
const HAND_WRITTEN_HOOKS = {
  // Codex's documented shape: the event map nested under a top-level `hooks` key.
  '.codex/hooks.json': {
    description: 'our own Codex hooks',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo MINE' }] }],
    },
  },
  '.cursor/hooks.json': {
    version: 1,
    hooks: { stop: [{ type: 'command', command: 'echo MINE cursor' }] },
  },
  '.github/hooks/copilot-hooks.json': {
    version: 1,
    hooks: { agentStop: [{ type: 'command', command: 'echo MINE copilot' }] },
  },
} as const;

/**
 * Stage the J-02 repo and scaffold its manifest, then return the paths.
 * The manifest is scaffolded BEFORE the snapshot: the journey is about what the
 * projection does, not about the one-time manifest write.
 */
function stageCodexFirstRepo(): { repoRoot: string; home: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-j02-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'harness-j02-home-'));

  writeFileAt(join(repoRoot, 'AGENTS.md'), '# Our project\n\nHouse rules.\n');
  for (const name of ['review', 'ship', 'triage', 'writeup']) {
    writeFileAt(join(repoRoot, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  for (const [rel, body] of Object.entries(HAND_WRITTEN_HOOKS)) {
    writeJsonAt(join(repoRoot, rel), body);
  }
  writeFileAt(
    join(repoRoot, '.codex', 'config.toml'),
    '[mcp_servers.linear]\ncommand = "linear"\n'
  );

  // The marketplace plugin the person is about to install, already on disk (the
  // install has landed; auto-projection runs after it).
  const plugin = join(repoRoot, '.dork', 'plugins', 'acme');
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: 'acme',
    version: '1.0.0',
    type: 'plugin',
    description: 'Acme test plugin',
    layers: ['skills', 'hooks'],
  });
  writeFileAt(join(plugin, 'skills', 'greet', 'SKILL.md'), '# greet\n');
  writeJsonAt(join(plugin, 'hooks', 'hooks.json'), {
    Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/done.mjs' }] }],
  });

  const scaffold = scaffoldManifest(repoRoot);
  expect(scaffold.created).toBe(true);
  expect(scaffold.detected).toBe(true);
  expect([...scaffold.harnesses]).toEqual(['codex', 'cursor']);

  return { repoRoot, home };
}

/** The three hand-written files, still holding exactly the bytes they were staged with. */
function expectHandWrittenFilesIntact(repoRoot: string): void {
  for (const [rel, body] of Object.entries(HAND_WRITTEN_HOOKS)) {
    expect(readText(join(repoRoot, rel))).toBe(`${JSON.stringify(body, null, 2)}\n`);
  }
}

describe('J-02 — an existing Codex project adopts DorkOS', () => {
  it('adds the plugin skill link, leaves all three hand-written hooks files alone, and names each', () => {
    const staged = stageCodexFirstRepo();
    repo = staged.repoRoot;
    dorkHome = staged.home;

    const before = snapshotTree(repo);

    // Pass 1 of auto-projection: no package has been allowed to contribute hooks
    // yet, which is exactly when the sweep used to run over these three paths.
    const plan = project(repo, { dorkHome, allowPluginHooks: () => false });
    const { conflicts } = applyPlan(repo, plan, { sweepOrphans: true });

    const after = snapshotTree(repo);
    expect(diffSnapshots(before, after)).toEqual({
      added: ['.agents/skills/acme__greet'],
      changed: [],
      removed: [],
    });

    expectHandWrittenFilesIntact(repo);

    expect(conflicts.map((c) => c.target).sort()).toEqual([
      '.codex/hooks.json',
      '.cursor/hooks.json',
      '.github/hooks/copilot-hooks.json',
    ]);
    for (const conflict of conflicts) {
      expect(conflict.reason).toContain('.claude/settings.json');
      expect(conflict.reason).toMatch(/delete the file/);
    }
  });

  it('still never overwrites the hand-written Codex file once the plugin hooks are allowed', () => {
    const staged = stageCodexFirstRepo();
    repo = staged.repoRoot;
    dorkHome = staged.home;

    const before = snapshotTree(repo);

    // Pass 2: the person said yes to the package's hooks, so the plan now WANTS
    // to write `.codex/hooks.json` (and `.cursor/hooks.json`). The person's file
    // still wins — it is reported once, and never rewritten.
    const plan = project(repo, { dorkHome, allowPluginHooks: () => true });
    const { conflicts } = applyPlan(repo, plan, { sweepOrphans: true });

    const after = snapshotTree(repo);
    expect(diffSnapshots(before, after)).toEqual({
      added: ['.agents/skills/acme__greet'],
      changed: [],
      removed: [],
    });

    expectHandWrittenFilesIntact(repo);

    const codexConflicts = conflicts.filter((c) => c.target === '.codex/hooks.json');
    expect(codexConflicts).toHaveLength(1);
    expect(codexConflicts[0].reason).toContain('.claude/settings.json');
  });
});
