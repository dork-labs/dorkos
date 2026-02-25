import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { symlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { scanDirectory } from '../discovery-engine.js';
import type { AutoImportedAgent, RegistryLike, DenialListLike } from '../discovery-engine.js';
import type { DiscoveryCandidate, AgentManifest } from '@dorkos/shared/mesh-schemas';
import { ClaudeCodeStrategy } from '../strategies/claude-code-strategy.js';
import { CursorStrategy } from '../strategies/cursor-strategy.js';
import { CodexStrategy } from '../strategies/codex-strategy.js';
import { writeManifest } from '../manifest.js';

// ---------------------------------------------------------------------------
// Type predicates for discriminating union results
// ---------------------------------------------------------------------------

function isCandidate(
  event: DiscoveryCandidate | AutoImportedAgent,
): event is DiscoveryCandidate {
  return !('type' in event);
}

function isAutoImport(
  event: DiscoveryCandidate | AutoImportedAgent,
): event is AutoImportedAgent {
  return 'type' in event && event.type === 'auto-import';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-engine-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01JKABC00001',
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: '2026-02-24T00:00:00.000Z',
    registeredBy: 'test',
    ...overrides,
  };
}

/** Empty registry mock — no agents registered. */
const emptyRegistry: RegistryLike = {
  getByPath: vi.fn().mockReturnValue(undefined),
};

/** Empty denial list mock — nothing denied. */
const emptyDenialList: DenialListLike = {
  isDenied: vi.fn().mockReturnValue(false),
};

const strategies = [new ClaudeCodeStrategy(), new CursorStrategy(), new CodexStrategy()];

async function collectAll(
  root: string,
  registry: RegistryLike = emptyRegistry,
  denialList: DenialListLike = emptyDenialList,
  options = {},
) {
  const results: Array<DiscoveryCandidate | AutoImportedAgent> = [];
  for await (const event of scanDirectory(root, strategies, registry, denialList, options)) {
    results.push(event);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Basic BFS discovery
// ---------------------------------------------------------------------------

describe('BFS traversal', () => {
  it('finds agents in nested directories up to maxDepth', async () => {
    const root = await makeTempDir();
    const projectA = path.join(root, 'project-a');
    await fs.mkdir(path.join(projectA, '.claude'), { recursive: true });
    await fs.writeFile(path.join(projectA, '.claude', 'CLAUDE.md'), '# A', 'utf-8');

    const projectB = path.join(root, 'nested', 'project-b');
    await fs.mkdir(path.join(projectB, '.cursor'), { recursive: true });

    const results = await collectAll(root);
    const candidates = results.filter(isCandidate);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.path)).toContain(projectA);
    expect(candidates.map((c) => c.path)).toContain(projectB);
  });

  it('skips directories beyond maxDepth', async () => {
    const root = await makeTempDir();

    // depth 1 project (should be found)
    const shallow = path.join(root, 'shallow');
    await fs.mkdir(path.join(shallow, '.claude'), { recursive: true });
    await fs.writeFile(path.join(shallow, '.claude', 'CLAUDE.md'), '# Shallow', 'utf-8');

    // depth 2 project (should be skipped at maxDepth=1)
    const deep = path.join(root, 'level1', 'deep');
    await fs.mkdir(path.join(deep, '.cursor'), { recursive: true });

    const results = await collectAll(root, emptyRegistry, emptyDenialList, { maxDepth: 1 });
    const candidates = results.filter(isCandidate);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].path).toBe(shallow);
  });

  it('skips node_modules directories', async () => {
    const root = await makeTempDir();
    const hidden = path.join(root, 'node_modules', 'hidden-project');
    await fs.mkdir(path.join(hidden, '.claude'), { recursive: true });
    await fs.writeFile(path.join(hidden, '.claude', 'CLAUDE.md'), '# Hidden', 'utf-8');

    const results = await collectAll(root);
    const candidates = results.filter(isCandidate);
    expect(candidates).toHaveLength(0);
  });

  it('uses first matching strategy (first match wins)', async () => {
    const root = await makeTempDir();
    // Create both .claude/CLAUDE.md and .cursor — ClaudeCode should win
    const project = path.join(root, 'multi');
    await fs.mkdir(path.join(project, '.claude'), { recursive: true });
    await fs.writeFile(path.join(project, '.claude', 'CLAUDE.md'), '# Multi', 'utf-8');
    await fs.mkdir(path.join(project, '.cursor'), { recursive: true });

    const results = await collectAll(root);
    const candidates = results.filter(isCandidate);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].strategy).toBe('claude-code');
  });
});

// ---------------------------------------------------------------------------
// Registry and denial filtering
// ---------------------------------------------------------------------------

describe('registry and denial filtering', () => {
  it('skips already-registered project paths', async () => {
    const root = await makeTempDir();
    const project = path.join(root, 'registered');
    await fs.mkdir(path.join(project, '.claude'), { recursive: true });
    await fs.writeFile(path.join(project, '.claude', 'CLAUDE.md'), '# Registered', 'utf-8');

    const registryWithAgent: RegistryLike = {
      getByPath: vi.fn().mockReturnValue({ id: '01JKABC00001' }),
    };

    const results = await collectAll(root, registryWithAgent);
    const candidates = results.filter(isCandidate);
    expect(candidates).toHaveLength(0);
  });

  it('skips denied project paths', async () => {
    const root = await makeTempDir();
    const project = path.join(root, 'denied');
    await fs.mkdir(path.join(project, '.claude'), { recursive: true });
    await fs.writeFile(path.join(project, '.claude', 'CLAUDE.md'), '# Denied', 'utf-8');

    const denialListWithDenied: DenialListLike = {
      isDenied: vi.fn().mockReturnValue(true),
    };

    const results = await collectAll(root, emptyRegistry, denialListWithDenied);
    const candidates = results.filter(isCandidate);
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Auto-import
// ---------------------------------------------------------------------------

describe('auto-import', () => {
  it('yields AutoImportedAgent for directories with .dork/agent.json', async () => {
    const root = await makeTempDir();
    const preRegistered = path.join(root, 'pre-registered');
    await fs.mkdir(preRegistered, { recursive: true });
    await writeManifest(preRegistered, makeManifest({ name: 'pre-registered-agent' }));

    const results = await collectAll(root);
    const autoImports = results.filter(isAutoImport);
    expect(autoImports).toHaveLength(1);
    expect(autoImports[0]).toMatchObject({
      type: 'auto-import',
      path: preRegistered,
      manifest: expect.objectContaining({ name: 'pre-registered-agent' }),
    });
  });

  it('does not yield auto-imported directory as a candidate', async () => {
    const root = await makeTempDir();
    const preRegistered = path.join(root, 'pre-registered');
    await fs.mkdir(path.join(preRegistered, '.claude'), { recursive: true });
    await fs.writeFile(path.join(preRegistered, '.claude', 'CLAUDE.md'), '# Pre', 'utf-8');
    await writeManifest(preRegistered, makeManifest());

    const results = await collectAll(root);
    const candidates = results.filter(isCandidate);
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Symlinks
// ---------------------------------------------------------------------------

describe('symlinks', () => {
  it('ignores symlinks when followSymlinks is false (default)', async () => {
    const root = await makeTempDir();
    const realProject = path.join(root, 'real-project');
    await fs.mkdir(path.join(realProject, '.claude'), { recursive: true });
    await fs.writeFile(path.join(realProject, '.claude', 'CLAUDE.md'), '# Real', 'utf-8');

    const linkDir = path.join(root, 'link-to-real');
    symlinkSync(realProject, linkDir);

    const results = await collectAll(root, emptyRegistry, emptyDenialList, {
      followSymlinks: false,
    });
    const candidates = results.filter(isCandidate);
    // Should find real-project but NOT link-to-real
    expect(candidates).toHaveLength(1);
    expect(candidates[0].path).toBe(realProject);
  });

  it('detects symlink cycle and skips duplicate via realpath tracking', async () => {
    const root = await makeTempDir();
    const projectDir = path.join(root, 'project');
    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.claude', 'CLAUDE.md'), '# Project', 'utf-8');

    // Create a symlink that points back to root (cycle)
    const cycleLink = path.join(projectDir, 'loop');
    symlinkSync(root, cycleLink);

    const results = await collectAll(root, emptyRegistry, emptyDenialList, {
      followSymlinks: true,
    });
    const candidates = results.filter(isCandidate);
    // Should find project exactly once despite the cycle
    expect(candidates).toHaveLength(1);
    expect(candidates[0].path).toBe(projectDir);
  });
});
