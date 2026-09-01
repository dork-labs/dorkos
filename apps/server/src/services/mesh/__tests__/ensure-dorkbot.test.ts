import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { readManifest } from '@dorkos/shared/manifest';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { seedAgentFace, AGENT_COLOR_PRESETS, AGENT_EMOJI_SET } from '@dorkos/shared/agent-face';
import { ensureDorkBot } from '../ensure-dorkbot.js';

// Minimal MeshCore mock
function createMockMeshCore() {
  return {
    syncFromDisk: vi.fn().mockResolvedValue(true),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    registerByPath: vi.fn(),
  } as unknown as Parameters<typeof ensureDorkBot>[0];
}

/** Whether a path exists, without throwing. */
async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

describe('ensureDorkBot', () => {
  let tmpDir: string;
  let meshCore: ReturnType<typeof createMockMeshCore>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkbot-test-'));
    meshCore = createMockMeshCore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scaffolds DorkBot workspace on fresh install', async () => {
    await ensureDorkBot(meshCore, tmpDir);

    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');

    // Verify manifest written
    const manifest = await readManifest(dorkbotDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe('dorkbot');
    expect(manifest!.displayName).toBe('DorkBot');
    expect(manifest!.isSystem).toBe(true);
    expect(manifest!.namespace).toBe('system');
    expect(manifest!.capabilities).toEqual(['tasks', 'summaries']);
    expect(manifest!.runtime).toBe('claude-code');

    // Verify convention files
    const soulContent = await fs.readFile(path.join(dorkbotDir, '.dork', 'SOUL.md'), 'utf-8');
    expect(soulContent).toContain('DorkBot');

    const nopeContent = await fs.readFile(path.join(dorkbotDir, '.dork', 'NOPE.md'), 'utf-8');
    expect(nopeContent).toContain('Safety Boundaries');

    // Cross-harness instruction files at the workspace root (replaces the old dead
    // `.dork/AGENTS.md`). The root-level AGENTS.md is what the harness + agent
    // discovery actually read; the Claude pointer defers to it.
    const agentsMd = await fs.readFile(path.join(dorkbotDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('DorkBot');
    const claudePointer = await fs.readFile(path.join(dorkbotDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudePointer).toBe('@../AGENTS.md\n');

    // Verify DB sync called
    expect(meshCore.syncFromDisk).toHaveBeenCalledWith(dorkbotDir);
  });

  // ── The face (DOR-949) ───────────────────────────────────────────────────

  it('gives DorkBot a face on a fresh install', async () => {
    await ensureDorkBot(meshCore, tmpDir);

    const manifest = await readManifest(path.join(tmpDir, 'agents', 'dorkbot'));
    expect(AGENT_COLOR_PRESETS.map((preset) => preset.hex)).toContain(manifest!.color);
    expect(AGENT_EMOJI_SET).toContain(manifest!.icon);
    expect({ color: manifest!.color, icon: manifest!.icon }).toEqual(seedAgentFace(manifest!.id));
  });

  // Red when the seed is applied on every boot instead of only at creation:
  // a DorkBot the operator deliberately left faceless would acquire one on the
  // next restart. Both REWRITING paths are covered — the system-agent upgrade
  // (Path 2) and the already-correct no-op (Path 4) — because a backfill added
  // to either one is the bug, and Path 4 alone would not catch it.
  it.each([
    { path: 'the upgrade path', isSystem: false, namespace: undefined },
    { path: 'the already-correct path', isSystem: true, namespace: 'system' },
  ])('leaves an existing faceless DorkBot faceless on $path', async ({ isSystem, namespace }) => {
    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const dorkDir = path.join(dorkbotDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });

    const existing: AgentManifest = {
      id: 'faceless-id',
      name: 'dorkbot',
      displayName: 'DorkBot',
      description: 'A DorkBot from before faces were seeded',
      runtime: 'claude-code',
      capabilities: ['tasks', 'summaries'],
      behavior: { responseMode: 'always' },
      traits: { ...DEFAULT_TRAITS },
      conventions: { soul: true, nope: true, dorkosKnowledge: true },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'dorkos-system',
      personaEnabled: true,
      isSystem,
      ...(namespace ? { namespace } : {}),
      enabledToolGroups: {},
    };
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify(existing, null, 2),
      'utf-8'
    );

    await ensureDorkBot(meshCore, tmpDir);

    const manifest = await readManifest(dorkbotDir);
    expect(manifest!.color).toBeUndefined();
    expect(manifest!.icon).toBeUndefined();
  });

  // ── The memory file (DOR-632) ────────────────────────────────────────────

  it('scaffolds MEMORY.md on a fresh install, with the visibility rule in it', async () => {
    await ensureDorkBot(meshCore, tmpDir);

    const memory = await fs.readFile(
      path.join(tmpDir, 'agents', 'dorkbot', '.dork', 'MEMORY.md'),
      'utf-8'
    );
    // The one paragraph an operator must see before writing anything into a
    // file that can surface in a room full of other people.
    expect(memory).toContain('can come up in ANY conversation this agent joins');
    expect(memory).toContain('Never');
    expect(memory).toContain('store secrets, credentials');
  });

  // Red when: the backfill is written beside the fresh-install scaffold instead
  // of in the common tail. Paths 2, 3 and 4 all return before Path 1, so an
  // install that already has a DorkBot — which is every install an upgrade is
  // for — would never get the file. A fresh-install test CANNOT fail for that
  // bug: it takes Path 1 and never reaches the tail.
  it('backfills MEMORY.md into an EXISTING install that has none', async () => {
    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const dorkDir = path.join(dorkbotDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });
    const existingManifest: AgentManifest = {
      id: 'existing-id',
      name: 'dorkbot',
      displayName: 'DorkBot',
      description: 'An install from before memory existed',
      runtime: 'claude-code',
      capabilities: ['tasks', 'summaries'],
      isSystem: true,
      namespace: 'system',
      behavior: { responseMode: 'always' },
      traits: { ...DEFAULT_TRAITS },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'dorkos-system',
      personaEnabled: true,
      enabledToolGroups: {},
    };
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify(existingManifest, null, 2),
      'utf-8'
    );
    // Path 4 (already correct) is the one that would skip a scaffold-side fix.
    expect(await fileExists(path.join(dorkDir, 'MEMORY.md'))).toBe(false);

    await ensureDorkBot(meshCore, tmpDir);

    const memory = await fs.readFile(path.join(dorkDir, 'MEMORY.md'), 'utf-8');
    expect(memory).toContain('can come up in ANY conversation this agent joins');
  });

  it('never overwrites a memory file the operator or the agent has written to', async () => {
    // First boot creates it; then it gains real content.
    await ensureDorkBot(meshCore, tmpDir);
    const memoryFile = path.join(tmpDir, 'agents', 'dorkbot', '.dork', 'MEMORY.md');
    const edited = '## Notes\n\n- the operator ships on Fridays (noted in #general, 2026-08-24)\n';
    await fs.writeFile(memoryFile, edited, 'utf-8');

    // A later boot re-runs the backfill. Write-if-absent means it must not fire.
    await ensureDorkBot(meshCore, tmpDir);

    expect(await fs.readFile(memoryFile, 'utf-8')).toBe(edited);
  });

  it('upgrades existing DorkBot to system agent', async () => {
    // Pre-create a DorkBot without isSystem
    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const dorkDir = path.join(dorkbotDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });

    const existingManifest: AgentManifest = {
      id: 'existing-id',
      name: 'dorkbot',
      description: 'Old description',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      traits: { ...DEFAULT_TRAITS, verbosity: 4 },
      conventions: { soul: true, nope: true, dorkosKnowledge: true },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'dorkos-ui',
      personaEnabled: true,
      isSystem: false,
      enabledToolGroups: {},
    };
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify(existingManifest, null, 2),
      'utf-8'
    );

    await ensureDorkBot(meshCore, tmpDir);

    // Verify upgraded
    const manifest = await readManifest(dorkbotDir);
    expect(manifest!.isSystem).toBe(true);
    expect(manifest!.namespace).toBe('system');
    expect(manifest!.capabilities).toEqual(['tasks', 'summaries']);
    // Backfills the display name during the upgrade
    expect(manifest!.displayName).toBe('DorkBot');
    // Preserves existing fields
    expect(manifest!.id).toBe('existing-id');
    expect(manifest!.traits.verbosity).toBe(4);
    expect(meshCore.syncFromDisk).toHaveBeenCalledWith(dorkbotDir);
  });

  it('backfills the display name on an existing system agent that lacks one', async () => {
    // Pre-create a system-agent DorkBot from before display names existed.
    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const dorkDir = path.join(dorkbotDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });

    const manifest: AgentManifest = {
      id: 'no-name-id',
      name: 'dorkbot',
      description: 'System agent without a display name',
      runtime: 'claude-code',
      capabilities: ['tasks', 'summaries'],
      behavior: { responseMode: 'always' },
      traits: { ...DEFAULT_TRAITS, verbosity: 2 },
      conventions: { soul: true, nope: true, dorkosKnowledge: true },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'dorkos-system',
      personaEnabled: true,
      isSystem: true,
      namespace: 'system',
      enabledToolGroups: {},
    };
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    await ensureDorkBot(meshCore, tmpDir);

    const patched = await readManifest(dorkbotDir);
    expect(patched!.displayName).toBe('DorkBot');
    // Everything else is preserved.
    expect(patched!.id).toBe('no-name-id');
    expect(patched!.traits.verbosity).toBe(2);
    expect(patched!.capabilities).toEqual(['tasks', 'summaries']);
    expect(meshCore.syncFromDisk).toHaveBeenCalledWith(dorkbotDir);
  });

  it('leaves a custom display name untouched and still syncs', async () => {
    // Pre-create a correctly configured DorkBot with a user-chosen display name.
    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const dorkDir = path.join(dorkbotDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });

    const manifest: AgentManifest = {
      id: 'correct-id',
      name: 'dorkbot',
      displayName: 'My Helper',
      description: 'Already a system agent',
      runtime: 'claude-code',
      capabilities: ['tasks', 'summaries'],
      behavior: { responseMode: 'always' },
      traits: DEFAULT_TRAITS,
      conventions: { soul: true, nope: true, dorkosKnowledge: true },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'dorkos-system',
      personaEnabled: true,
      isSystem: true,
      namespace: 'system',
      enabledToolGroups: {},
    };
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    await ensureDorkBot(meshCore, tmpDir);

    // Manifest untouched (no rewrite), but sync still runs so RelayBridge
    // re-asserts default access rules (system-agent cross-namespace allow)
    // on every boot for existing installs.
    const raw = await fs.readFile(path.join(dorkDir, 'agent.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual(manifest);
    expect(meshCore.syncFromDisk).toHaveBeenCalledWith(dorkbotDir);
  });

  // ── Operating DorkOS skill pack seeding (DOR-433) ───────────────────────

  it('seeds the Operating DorkOS skill pack into DorkBot on fresh install', async () => {
    await ensureDorkBot(meshCore, tmpDir);

    const umbrella = path.join(
      tmpDir,
      'agents',
      'dorkbot',
      '.agents',
      'skills',
      'operating-dorkos',
      'SKILL.md'
    );
    const content = await fs.readFile(umbrella, 'utf-8');
    expect(content).toContain('name: operating-dorkos');
    expect(content).toContain('dorkosPack: operating-dorkos');
  });

  it('re-seeds on boot but never clobbers a user-modified skill', async () => {
    // First boot seeds the pack.
    await ensureDorkBot(meshCore, tmpDir);

    const umbrella = path.join(
      tmpDir,
      'agents',
      'dorkbot',
      '.agents',
      'skills',
      'operating-dorkos',
      'SKILL.md'
    );

    // The user edits a seeded skill's body.
    const original = await fs.readFile(umbrella, 'utf-8');
    const edited = original.replace('# Operating DorkOS', '# Operating DorkOS\n\nMY EDITS.');
    await fs.writeFile(umbrella, edited, 'utf-8');

    // A subsequent boot (path 4 — already correct) re-seeds but preserves the edit.
    await ensureDorkBot(meshCore, tmpDir);

    const after = await fs.readFile(umbrella, 'utf-8');
    expect(after).toBe(edited);
    expect(after).toContain('MY EDITS.');
  });

  // ── Skill projection to DorkBot's harness (DOR-659) ─────────────────────

  it('links the seeded skills where DorkBot runtime reads them', async () => {
    await ensureDorkBot(meshCore, tmpDir);

    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const seeded = await fs.readdir(path.join(dorkbotDir, '.agents', 'skills'));
    expect(seeded.length).toBeGreaterThan(0);

    for (const name of seeded) {
      const link = path.join(dorkbotDir, '.claude', 'skills', name);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(link)).toBe(
        await fs.realpath(path.join(dorkbotDir, '.agents', 'skills', name))
      );
    }
  });

  it('re-links a skill whose link was deleted, so DorkBot self-heals on boot', async () => {
    await ensureDorkBot(meshCore, tmpDir);

    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const link = path.join(dorkbotDir, '.claude', 'skills', 'operating-dorkos');
    await fs.rm(link);

    await ensureDorkBot(meshCore, tmpDir);

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(link)).toBe(
      await fs.realpath(path.join(dorkbotDir, '.agents', 'skills', 'operating-dorkos'))
    );
  });
});
