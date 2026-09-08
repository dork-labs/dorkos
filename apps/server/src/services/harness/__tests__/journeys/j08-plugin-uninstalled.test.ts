/**
 * J-08 — the person uninstalls the package J-04 installed.
 *
 * Same repository, one step later. The marketplace's uninstall removes
 * `.dork/plugins/flow` and fires the same trigger with `action: 'uninstall'`,
 * and the sweep that follows is the one operation in this engine that DELETES
 * things in somebody's repository. So the bar is exact in both directions: every
 * link, wrapper, self-listing `.gitignore`, generated hook file, ownership
 * sidecar and settings hook group the install added is gone, and NOTHING the
 * person wrote is touched.
 *
 * The fixture therefore stages a person's own artifact at every kind of path the
 * sweep walks — an authored skill in each skills dir, their own slash command,
 * their own hooks in `.claude/settings.json`, and their own untagged group in
 * `.claude/settings.local.json`, which is the file the engine MERGES into rather
 * than owns. A sweep that took any of them would show up here as a `removed` or
 * `changed` entry the assertion did not name.
 *
 * Rows: J-08, AP-08 (uninstall sweeps what the install wrote), AP-07 (the sweep
 * only ever deletes what it wrote).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffSnapshots,
  readText,
  snapshotTree,
  stageRepo,
  type SnapshotEntry,
  type StagedRepo,
} from '@dorkos/harness/journeys';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

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

/** The command the package wants a harness to run at the end of every turn. */
const FLOW_HOOK = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/flow-loop.mjs"';

/** The person's own hook, in the same file the engine merges the package's into. */
const PERSON_LOCAL_HOOK = 'echo mine';

let staged: StagedRepo | undefined;

/** Stage the repo J-04 left behind, with the person's own work all around it. */
function stageInstalledRepo(): StagedRepo {
  staged = stageRepo({
    manifest: { harnesses: ['claude-code', 'codex'] },
    git: true,
    agents: { agentsMd: true, skills: ['house-style'] },
    claude: {
      skills: ['review'],
      commands: ['deploy'],
      settingsHooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
      settingsLocalHooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: PERSON_LOCAL_HOOK }] }],
      },
    },
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

/** Run one trigger pass, saying yes to whatever the package asks for. */
async function trigger(repo: StagedRepo, action: 'install' | 'uninstall'): Promise<void> {
  await runAutoProjection(
    { projectPath: repo.root, packageName: 'flow', action },
    {
      dorkHome: repo.dorkHome,
      approvals: {
        request: vi.fn().mockReturnValue(ticket()),
        consume: vi
          .fn()
          .mockReturnValue({ outcome: 'granted', approvalId: 'a1', capabilityId: 'x' }),
      },
    }
  );
}

/** Every path the person wrote themselves, which the sweep must never reach. */
const AUTHORED = [
  '.agents/harness.manifest.json',
  '.agents/skills/house-style/SKILL.md',
  '.claude/commands/deploy.md',
  '.claude/settings.json',
  '.claude/skills/review/SKILL.md',
  'AGENTS.md',
] as const;

/** The snapshot entries for {@link AUTHORED}, so a byte change anywhere shows. */
function authoredEntries(tree: Map<string, SnapshotEntry>): Record<string, SnapshotEntry> {
  return Object.fromEntries(AUTHORED.map((path) => [path, tree.get(path) as SnapshotEntry]));
}

beforeEach(() => {
  vi.clearAllMocks();
  config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
});

afterEach(() => {
  staged?.cleanup();
  staged = undefined;
});

describe('J-08 — uninstalling the package that was installed', () => {
  it('J-08, AP-08, AP-07: takes back every file it wrote, and nothing else', async () => {
    const repo = stageInstalledRepo();
    const clean = snapshotTree(repo.root);
    await trigger(repo, 'install');
    const installed = snapshotTree(repo.root);

    // The install really did write into all four places the sweep has to reach,
    // so the removals below are a statement about a sweep and not about an empty
    // tree.
    expect(diffSnapshots(clean, installed).added).toEqual([
      '.agents/skills/flow__capture',
      '.agents/skills/flow__drain',
      // The person's own two projections, which the uninstall must NOT take: the
      // pointer at their AGENTS.md, and the link that puts their canonical skill
      // where Claude Code reads it. Both live in the same directories the sweep
      // walks, which is exactly why they are staged here.
      '.claude/CLAUDE.md',
      '.claude/commands/flow',
      '.claude/commands/flow/.gitignore',
      '.claude/commands/flow/capture.md',
      '.claude/skills/flow__capture',
      '.claude/skills/flow__drain',
      '.claude/skills/house-style',
      '.codex',
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
    ]);
    expect(readText(join(repo.root, '.claude/settings.local.json'))).toContain('flow-loop.mjs');

    // The uninstaller removes the package directory, then fires the trigger.
    rmSync(join(repo.root, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    await trigger(repo, 'uninstall');

    expect(diffSnapshots(installed, snapshotTree(repo.root))).toEqual({
      added: [],
      // Two files the engine does not own outright, so they are rewritten rather
      // than deleted: the settings file it merged one group into, and the
      // generated Codex hooks file, which still carries the person's own `Stop`
      // hook from `.claude/settings.json`.
      changed: [
        '.claude/settings.local.json',
        '.codex/hooks.json',
        '.codex/hooks.json.dorkos-generated',
      ],
      removed: [
        '.agents/skills/flow__capture',
        '.agents/skills/flow__drain',
        '.claude/commands/flow',
        '.claude/commands/flow/.gitignore',
        '.claude/commands/flow/capture.md',
        '.claude/skills/flow__capture',
        '.claude/skills/flow__drain',
        // The person's own `rm -rf` of the package (the uninstaller's), not the
        // engine's sweep — `.dork/plugins/` itself stays.
        '.dork/plugins/flow',
        '.dork/plugins/flow/.dork',
        '.dork/plugins/flow/.dork/manifest.json',
        '.dork/plugins/flow/commands',
        '.dork/plugins/flow/commands/capture.md',
        '.dork/plugins/flow/hooks',
        '.dork/plugins/flow/hooks/hooks.json',
        '.dork/plugins/flow/skills',
        '.dork/plugins/flow/skills/capture',
        '.dork/plugins/flow/skills/capture/SKILL.md',
        '.dork/plugins/flow/skills/drain',
        '.dork/plugins/flow/skills/drain/SKILL.md',
      ],
    });
  });

  it('J-08, AP-07: the package’s hook group goes and the person’s stays', async () => {
    const repo = stageInstalledRepo();
    await trigger(repo, 'install');
    rmSync(join(repo.root, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    await trigger(repo, 'uninstall');

    const settings = readText(join(repo.root, '.claude/settings.local.json'));

    expect(settings).not.toContain('flow-loop.mjs');
    expect(settings).not.toContain('_dorkosHarness');
    expect(settings).toContain(PERSON_LOCAL_HOOK);
    // The generated Codex file survives because an authored hook still feeds it —
    // with the package's command gone from it.
    const codex = readText(join(repo.root, '.codex/hooks.json'));
    expect(codex).not.toContain('flow-loop.mjs');
    expect(codex).toContain('echo bye');
  });

  it('J-08, AP-07: every file the person wrote is byte-identical afterwards', async () => {
    const repo = stageInstalledRepo();
    const clean = snapshotTree(repo.root);
    await trigger(repo, 'install');
    rmSync(join(repo.root, '.dork', 'plugins', 'flow'), { recursive: true, force: true });
    await trigger(repo, 'uninstall');

    // Compared as hashed entries rather than as an existence check: a sweep that
    // rewrote a person's skill in place, or replaced their command with an empty
    // file, would pass `existsSync` and fail here.
    const after = snapshotTree(repo.root);
    expect(authoredEntries(after)).toEqual(authoredEntries(clean));
    for (const path of AUTHORED) expect(after.get(path)?.kind).toBe('file');
  });
});
