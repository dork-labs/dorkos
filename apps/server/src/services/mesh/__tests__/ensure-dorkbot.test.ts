import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { readManifest } from '@dorkos/shared/manifest';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
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
});
