import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { readManifest } from '@dorkos/shared/manifest';
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
    expect(manifest!.isSystem).toBe(true);
    expect(manifest!.namespace).toBe('system');
    expect(manifest!.capabilities).toEqual(['tasks', 'summaries']);
    expect(manifest!.runtime).toBe('claude-code');

    // Verify convention files
    const soulContent = await fs.readFile(path.join(dorkbotDir, '.dork', 'SOUL.md'), 'utf-8');
    expect(soulContent).toContain('DorkBot');

    const nopeContent = await fs.readFile(path.join(dorkbotDir, '.dork', 'NOPE.md'), 'utf-8');
    expect(nopeContent).toContain('Safety Boundaries');

    const claudeMd = await fs.readFile(path.join(dorkbotDir, '.dork', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('DorkBot');

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
      budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      traits: { tone: 4, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
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
    // Preserves existing fields
    expect(manifest!.id).toBe('existing-id');
    expect(manifest!.traits.tone).toBe(4);
    expect(meshCore.syncFromDisk).toHaveBeenCalledWith(dorkbotDir);
  });

  it('is a no-op when DorkBot is already a system agent', async () => {
    // Pre-create a correctly configured DorkBot
    const dorkbotDir = path.join(tmpDir, 'agents', 'dorkbot');
    const dorkDir = path.join(dorkbotDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });

    const manifest: AgentManifest = {
      id: 'correct-id',
      name: 'dorkbot',
      description: 'Already a system agent',
      runtime: 'claude-code',
      capabilities: ['tasks', 'summaries'],
      behavior: { responseMode: 'always' },
      budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
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

    // No sync needed — already correct
    expect(meshCore.syncFromDisk).not.toHaveBeenCalled();
  });
});
