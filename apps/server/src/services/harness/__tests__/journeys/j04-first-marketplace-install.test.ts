/**
 * J-04 — a fresh project, and the first thing installed into it from the app.
 *
 * The tree is a repository with no `.agents/`, no `.claude/` and no manifest —
 * a project that has never met DorkOS. Somebody installs `flow` at project
 * scope from the marketplace page, and the install route fires
 * `runAutoProjection`, which is the door every marketplace install enters by.
 * The package ships all four portable kinds: a plain skill, a SCHEDULED skill,
 * a slash command, and hooks — shell commands a harness would run unattended.
 *
 * The journey is here rather than in `packages/harness` because the thing under
 * test is the seam, not the planner: the manifest scaffold, the consent card,
 * the withhold-until-yes ordering, and the second pass that runs after the yes.
 * Every beat is measured as an exact before/after tree diff, so a file that
 * appears one step too early is a red rather than a detail nobody looked at.
 *
 * Rows: J-04, SRC-02 (a project-scope marketplace install), SK-02 (a scheduled
 * skill reaches `.agents/skills` whatever harnesses are enabled), SK-03 (skills
 * land in both dirs), CM-01/CM-03 (the Claude Code wrapper and its self-listing
 * `.gitignore`), HK-05/HK-06/HK-07 (hooks are asked about, withheld until yes,
 * and recorded once), AP-09 (the `.gitignore` contract for ephemeral targets).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { missingGitignoreLines, project } from '@dorkos/harness';
import {
  diffSnapshots,
  readText,
  snapshotTree,
  stageRepo,
  type StagedRepo,
} from '@dorkos/harness/journeys';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * A stateful stand-in for the config store: the second projection pass re-reads
 * the approval it just wrote to decide whether the hooks may land, so a write
 * has to be visible to the very next read.
 */
const config: {
  harness: { autoSync: boolean; approvedHooks: string[]; refusedHooks: string[] };
} = { harness: { autoSync: true, approvedHooks: [], refusedHooks: [] } };

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (config as Record<string, unknown>)[key],
    set: (key: string, value: unknown) => {
      (config as Record<string, unknown>)[key] = value;
    },
  },
}));

import { runAutoProjection } from '../../auto-project.js';

/** The command the package wants Claude Code to run at the end of every turn. */
const FLOW_HOOK = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/flow-loop.mjs"';

let staged: StagedRepo | undefined;

/** Stage the fresh project with `flow` already unpacked, as the installer leaves it. */
function stageFreshInstall(): StagedRepo {
  staged = stageRepo({
    manifest: false,
    // A real git checkout, because the `.gitignore` half of this journey (AP-09)
    // is silent about a tree git does not track — correctly, and it would make
    // the assertion below vacuous.
    git: true,
    plugins: [
      {
        name: 'flow',
        scope: 'project',
        skills: ['capture'],
        scheduled: ['drain'],
        commands: ['capture'],
        hooks: { Stop: [{ hooks: [{ type: 'command', command: FLOW_HOOK }] }] },
      },
    ],
  });
  return staged;
}

/** The approval ticket a gateway hands back, valid for a minute. */
function ticket() {
  return { approvalId: 'a1', token: 't1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

/** Run the install trigger with an approval gateway that answers `outcome`. */
async function install(repo: StagedRepo, outcome: 'granted' | 'denied'): Promise<void> {
  await runAutoProjection(
    { projectPath: repo.root, packageName: 'flow', action: 'install' },
    {
      dorkHome: repo.dorkHome,
      approvals: {
        request: vi.fn().mockReturnValue(ticket()),
        consume: vi.fn().mockReturnValue({ outcome, approvalId: 'a1', capabilityId: 'x' }),
      },
    }
  );
}

/** Everything the install writes when the person turns the hooks down. */
const WITHOUT_HOOKS = [
  '.agents',
  '.agents/harness.manifest.json',
  '.agents/skills',
  '.agents/skills/flow__capture',
  '.agents/skills/flow__drain',
  '.claude',
  '.claude/commands',
  '.claude/commands/flow',
  '.claude/commands/flow/.gitignore',
  '.claude/commands/flow/capture.md',
  '.claude/skills',
  '.claude/skills/flow__capture',
  '.claude/skills/flow__drain',
].sort();

/** The two files that appear only after a yes, and nowhere else. */
const HOOK_FILES = ['.claude/settings.local.json', '.codex', '.codex/hooks.json'].sort();

beforeEach(() => {
  vi.clearAllMocks();
  config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
});

afterEach(() => {
  staged?.cleanup();
  staged = undefined;
});

describe('J-04 — the first marketplace install into a fresh project', () => {
  it('J-04, SRC-02, SK-02, SK-03, CM-01, HK-06: a no leaves nothing hook-shaped on disk', async () => {
    const repo = stageFreshInstall();
    const before = snapshotTree(repo.root);
    // The package really is on disk before anything runs — otherwise "no hooks
    // landed" would be a statement about an install that never happened.
    expect(existsSync(join(repo.root, '.dork', 'plugins', 'flow', 'hooks', 'hooks.json'))).toBe(
      true
    );

    await install(repo, 'denied');

    // Everything portable projects; nothing that runs a shell command does.
    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: WITHOUT_HOOKS,
      changed: [],
      removed: [],
    });
    // The manifest is scaffolded by detection, and a fresh tree detects nothing —
    // so a person gets the default pair rather than an empty harness list.
    expect(JSON.parse(readText(join(repo.root, '.agents/harness.manifest.json')))).toMatchObject({
      version: 1,
      harnesses: ['claude-code', 'codex'],
    });
    // The scheduled skill reaches `.agents/skills` — the only skills root the
    // DorkOS scheduler watches — whatever harnesses the project enables (SK-02).
    expect(existsSync(join(repo.root, '.agents/skills/flow__drain'))).toBe(true);
    // And the wrapper Claude Code invokes as `/flow:capture` names the package's
    // real install dir, since `${CLAUDE_PLUGIN_ROOT}` does not resolve off disk.
    expect(readText(join(repo.root, '.claude/commands/flow/capture.md'))).toContain('flow');
  });

  it('J-04, HK-05, HK-07: a yes writes the hook files, and records the decision once', async () => {
    const repo = stageFreshInstall();
    const before = snapshotTree(repo.root);

    await install(repo, 'granted');

    expect(diffSnapshots(before, snapshotTree(repo.root))).toEqual({
      added: [...WITHOUT_HOOKS, ...HOOK_FILES, '.codex/hooks.json.dorkos-generated'].sort(),
      changed: [],
      removed: [],
    });
    // Under `hooks`, beside the `description` Codex documents — not a bare event
    // map, which is the shape nothing ever read (HK-01).
    const codex = JSON.parse(readText(join(repo.root, '.codex/hooks.json'))) as {
      description: string;
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(codex).sort()).toEqual(['description', 'hooks']);
    expect(JSON.stringify(codex.hooks.Stop)).toContain('flow-loop.mjs');
    // One approval, recorded — so the next install of the same package is silent.
    expect(config.harness.approvedHooks).toHaveLength(1);
    expect(config.harness.refusedHooks).toEqual([]);
  });

  it('J-04, AP-09: names the ephemeral lines this repo is missing from its .gitignore', async () => {
    const repo = stageFreshInstall();
    await install(repo, 'granted');

    const missing = missingGitignoreLines(
      repo.root,
      project(repo.root, { dorkHome: repo.dorkHome })
    );

    // Every path the install created that a teammate's clone must not inherit.
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('.dork/plugins/');
  });

  it('J-04, AP-09: says nothing when the repo already covers its own ephemeral paths', async () => {
    // The other half of the contract, and the one a guard needs: a repo that has
    // done what it was told must stop being told. Without this, a
    // `missingGitignoreLines` that returned its whole pattern list unconditionally
    // would pass the assertion above.
    staged = stageRepo({
      manifest: false,
      git: true,
      gitignore: ['.dork/plugins/', '.claude/skills/*__*', '.agents/skills/*__*'],
      plugins: [{ name: 'flow', scope: 'project', skills: ['capture'], commands: ['capture'] }],
    });
    await install(staged, 'denied');

    const missing = missingGitignoreLines(
      staged.root,
      project(staged.root, { dorkHome: staged.dorkHome })
    );

    expect(missing).not.toContain('.dork/plugins/');
  });
});
