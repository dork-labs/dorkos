/** Shared setup for the MeshCore test files: temp dirs, a manifest builder and project trees. */
import { afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { AgentManifest, DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import type { ScanEvent } from '../discovery/types.js';

/** Collect only candidate events from a discover() stream. */
export async function collectCandidates(
  stream: AsyncGenerator<ScanEvent>
): Promise<DiscoveryCandidate[]> {
  const candidates: DiscoveryCandidate[] = [];
  for await (const event of stream) {
    if (event.type === 'candidate') candidates.push(event.data);
  }
  return candidates;
}

const tempDirs: string[] = [];

/** Make a temp dir that is removed after the current test. */
export async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-core-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Register the afterEach that removes every temp dir a test made. */
export function cleanTempDirsAfterEach(): void {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

/** A complete agent manifest with overridable fields. */
export function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id: '01JKABC00001',
    name: 'pre-registered',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-02-24T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    mcpServers: [],
    ...overrides,
  };
}

/** Two projects under `rootDir`: one with AGENTS.md, one with a .cursor dir. */
export async function setupProjects(rootDir: string) {
  const projectA = path.join(rootDir, 'project-a');
  await fs.mkdir(projectA, { recursive: true });
  await fs.writeFile(path.join(projectA, 'AGENTS.md'), '# Project A', 'utf-8');

  const projectB = path.join(rootDir, 'project-b');
  await fs.mkdir(path.join(projectB, '.cursor'), { recursive: true });

  return { projectA, projectB };
}
