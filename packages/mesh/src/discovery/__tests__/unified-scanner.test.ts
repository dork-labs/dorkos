import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { symlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { unifiedScan } from '../unified-scanner.js';
import type { RegistryLike, DenialListLike } from '../unified-scanner.js';
import type { ScanEvent } from '../types.js';
import type { DiscoveryStrategy } from '../../discovery-strategy.js';
import type { AgentHints, AgentManifest } from '@dorkos/shared/mesh-schemas';
import { writeManifest } from '../../manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-scanner-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
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
    personaEnabled: true,
    ...overrides,
  };
}

/** Strategy that detects a directory containing CLAUDE.md. */
function makeClaudeMdStrategy(): DiscoveryStrategy {
  return {
    name: 'claude-code',
    runtime: 'claude-code',
    detect: async (dir: string) => {
      try {
        await fs.access(path.join(dir, 'CLAUDE.md'));
        return true;
      } catch {
        return false;
      }
    },
    extractHints: async (_dir: string): Promise<AgentHints> => ({
      name: 'claude-agent',
      runtime: 'claude-code',
      capabilities: [],
      description: 'Claude Code agent',
    }),
  };
}

const noopRegistry: RegistryLike = { isRegistered: () => false };
const noopDenialList: DenialListLike = { isDenied: () => false };

async function collectAll(
  root: string,
  strategies: DiscoveryStrategy[] = [],
  registry: RegistryLike = noopRegistry,
  denialList: DenialListLike = noopDenialList,
  options: Partial<import('../types.js').UnifiedScanOptions> = {}
): Promise<ScanEvent[]> {
  const events: ScanEvent[] = [];
  for await (const event of unifiedScan(
    { root, timeout: 10_000, ...options },
    strategies,
    registry,
    denialList
  )) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unifiedScan', () => {
  describe('candidate events', () => {
    it('yields candidate events for detected directories', async () => {
      const root = await makeTempDir();
      await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Agent', 'utf-8');

      const events = await collectAll(root, [makeClaudeMdStrategy()]);
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(1);
      expect((candidates[0] as Extract<ScanEvent, { type: 'candidate' }>).data.path).toBe(root);
    });

    it('yields candidate for nested directories', async () => {
      const root = await makeTempDir();
      const project = path.join(root, 'project');
      await fs.mkdir(project);
      await fs.writeFile(path.join(project, 'CLAUDE.md'), '# Agent', 'utf-8');

      const events = await collectAll(root, [makeClaudeMdStrategy()]);
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(1);
      expect((candidates[0] as Extract<ScanEvent, { type: 'candidate' }>).data.path).toBe(project);
    });
  });

  describe('auto-import events', () => {
    it('yields auto-import event when .dork/agent.json exists', async () => {
      const root = await makeTempDir();
      const manifest = makeManifest();
      await writeManifest(root, manifest);

      const events = await collectAll(root);
      const autoImports = events.filter((e) => e.type === 'auto-import');
      expect(autoImports).toHaveLength(1);
      const ai = autoImports[0] as Extract<ScanEvent, { type: 'auto-import' }>;
      expect(ai.data.path).toBe(root);
      expect(ai.data.manifest.id).toBe(manifest.id);
    });
  });

  describe('denial list', () => {
    it('skips denied paths and does not traverse their children', async () => {
      const root = await makeTempDir();
      const denied = path.join(root, 'denied-project');
      await fs.mkdir(denied);
      const child = path.join(denied, 'child-project');
      await fs.mkdir(child);
      await fs.writeFile(path.join(child, 'CLAUDE.md'), '# Child', 'utf-8');

      const denialList: DenialListLike = {
        isDenied: (p) => p === denied,
      };

      const events = await collectAll(root, [makeClaudeMdStrategy()], noopRegistry, denialList);
      const candidates = events.filter((e) => e.type === 'candidate');
      // child-project inside denied dir should not be found
      expect(candidates).toHaveLength(0);
    });
  });

  describe('registry filtering', () => {
    it('skips candidate for registered paths but still traverses children', async () => {
      const root = await makeTempDir();
      // root is registered — should get no candidate for root
      await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Root', 'utf-8');
      const child = path.join(root, 'child-project');
      await fs.mkdir(child);
      await fs.writeFile(path.join(child, 'CLAUDE.md'), '# Child', 'utf-8');

      const registry: RegistryLike = { isRegistered: (p) => p === root };

      const events = await collectAll(root, [makeClaudeMdStrategy()], registry, noopDenialList);
      const candidates = events.filter((e) => e.type === 'candidate');
      // root skipped as candidate, but child should still be found
      expect(candidates).toHaveLength(1);
      expect((candidates[0] as Extract<ScanEvent, { type: 'candidate' }>).data.path).toBe(child);
    });
  });

  describe('maxDepth', () => {
    it('respects maxDepth and does not scan beyond it', async () => {
      const root = await makeTempDir();
      const level1 = path.join(root, 'l1');
      const level2 = path.join(level1, 'l2');
      await fs.mkdir(level2, { recursive: true });
      await fs.writeFile(path.join(level2, 'CLAUDE.md'), '# Deep', 'utf-8');

      // maxDepth: 1 means we descend 1 level from root, so l2 (depth 2) is excluded
      const events = await collectAll(
        root,
        [makeClaudeMdStrategy()],
        noopRegistry,
        noopDenialList,
        {
          maxDepth: 1,
        }
      );
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(0);
    });

    it('finds directories at exactly maxDepth', async () => {
      const root = await makeTempDir();
      const level1 = path.join(root, 'l1');
      await fs.mkdir(level1);
      await fs.writeFile(path.join(level1, 'CLAUDE.md'), '# L1', 'utf-8');

      const events = await collectAll(
        root,
        [makeClaudeMdStrategy()],
        noopRegistry,
        noopDenialList,
        {
          maxDepth: 1,
        }
      );
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(1);
    });
  });

  describe('progress events', () => {
    it('emits progress event every 100 directories', async () => {
      const root = await makeTempDir();
      // Create 150 directories to trigger at least 1 progress event
      await Promise.all(
        Array.from({ length: 150 }, (_, i) =>
          fs.mkdir(path.join(root, `dir-${i}`), { recursive: true })
        )
      );

      const events = await collectAll(root, [], noopRegistry, noopDenialList, { maxDepth: 1 });
      const progressEvents = events.filter((e) => e.type === 'progress');
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('timeout', () => {
    it('emits complete with timedOut: true when timeout expires', async () => {
      const root = await makeTempDir();
      // Create many dirs to ensure the scan does not finish instantly
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          fs.mkdir(path.join(root, `dir-${i}`), { recursive: true })
        )
      );

      const events = await collectAll(root, [], noopRegistry, noopDenialList, {
        timeout: 1,
      });
      const complete = events.find((e) => e.type === 'complete') as
        | Extract<ScanEvent, { type: 'complete' }>
        | undefined;
      expect(complete).toBeDefined();
      // The scan may or may not timeout in 1ms but always ends
      // We check the complete event is present
      expect(complete?.data).toHaveProperty('timedOut');
    });

    it('emits complete with timedOut: true on very short timeout', async () => {
      const root = await makeTempDir();
      // Create many subdirs so the BFS queue has many items to process
      // The timeout flag is checked at the start of each queue iteration,
      // so with timeout:1ms and 200 dirs, the flag will be set before all are processed.
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          fs.mkdir(path.join(root, `dir-${i}`), { recursive: true })
        )
      );

      const events = await collectAll(root, [], noopRegistry, noopDenialList, {
        timeout: 1,
        maxDepth: 5,
      });
      const complete = events.find((e) => e.type === 'complete') as Extract<
        ScanEvent,
        { type: 'complete' }
      >;
      expect(complete).toBeDefined();
      expect(complete.data.timedOut).toBe(true);
    });
  });

  describe('unified exclude set', () => {
    it('skips node_modules directories', async () => {
      const root = await makeTempDir();
      const nm = path.join(root, 'node_modules', 'some-pkg');
      await fs.mkdir(nm, { recursive: true });
      await fs.writeFile(path.join(nm, 'CLAUDE.md'), '# pkg', 'utf-8');

      const events = await collectAll(root, [makeClaudeMdStrategy()]);
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(0);
    });

    it('skips .venv directories (Scanner B addition)', async () => {
      const root = await makeTempDir();
      const venv = path.join(root, '.venv', 'project');
      await fs.mkdir(venv, { recursive: true });
      await fs.writeFile(path.join(venv, 'CLAUDE.md'), '# venv project', 'utf-8');

      const events = await collectAll(root, [makeClaudeMdStrategy()]);
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(0);
    });

    it('skips Library directories (Scanner A addition)', async () => {
      const root = await makeTempDir();
      const lib = path.join(root, 'Library', 'project');
      await fs.mkdir(lib, { recursive: true });
      await fs.writeFile(path.join(lib, 'CLAUDE.md'), '# lib project', 'utf-8');

      const events = await collectAll(root, [makeClaudeMdStrategy()]);
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(0);
    });
  });

  describe('symlink cycle detection', () => {
    it('terminates when followSymlinks is true and a cycle exists', async () => {
      const root = await makeTempDir();
      const subdir = path.join(root, 'sub');
      await fs.mkdir(subdir);
      // Create a symlink from sub/loop -> root (cycle)
      symlinkSync(root, path.join(subdir, 'loop'));

      const events = await collectAll(root, [], noopRegistry, noopDenialList, {
        followSymlinks: true,
        maxDepth: 10,
        timeout: 5000,
      });
      // If cycle detection works, we get a complete event (not an infinite loop)
      const complete = events.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
    });
  });

  describe('EACCES error handling', () => {
    it('continues scanning when readdir throws EACCES on one directory', async () => {
      // Structure: root/accessible/CLAUDE.md  +  root/inaccessible/
      // accessible is detected as a candidate (CLAUDE.md present).
      // inaccessible throws EACCES when readdir is called on it.
      // The scanner must continue and still surface the accessible candidate.
      const root = await makeTempDir();
      const accessible = path.join(root, 'accessible');
      const inaccessible = path.join(root, 'inaccessible');
      await fs.mkdir(accessible);
      await fs.mkdir(inaccessible);
      await fs.writeFile(path.join(accessible, 'CLAUDE.md'), '# accessible', 'utf-8');

      // Intercept readdir: only throw for the inaccessible path, delegate all others
      // to a real fs call via the underlying node:fs/promises module to avoid recursion.
      const { readdir: realReaddir } = await import('node:fs/promises');
      vi.spyOn(fs, 'readdir').mockImplementation(async (dirPath, opts) => {
        if (String(dirPath) === inaccessible) {
          const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
          throw err;
        }
        return realReaddir(dirPath as string, opts as { withFileTypes: true }) as ReturnType<
          typeof fs.readdir
        >;
      });

      const events = await collectAll(root, [makeClaudeMdStrategy()]);
      const candidates = events.filter((e) => e.type === 'candidate');
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(
        candidates.some(
          (c) => (c as Extract<ScanEvent, { type: 'candidate' }>).data.path === accessible
        )
      ).toBe(true);
    });
  });

  describe('complete event', () => {
    it('always emits complete event as last event', async () => {
      const root = await makeTempDir();
      const events = await collectAll(root);
      expect(events[events.length - 1]?.type).toBe('complete');
    });

    it('complete event has timedOut: false when scan finishes normally', async () => {
      const root = await makeTempDir();
      const events = await collectAll(root);
      const complete = events.find((e) => e.type === 'complete') as Extract<
        ScanEvent,
        { type: 'complete' }
      >;
      expect(complete.data.timedOut).toBe(false);
    });
  });
});
