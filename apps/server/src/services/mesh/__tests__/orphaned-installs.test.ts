/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { logOrphanedInstalls } from '../orphaned-installs.js';

/** Write a `.dork/manifest.json` under `<projectPath>/.dork/plugins/<name>`. */
async function writeAgentPlugin(
  projectPath: string,
  name: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const dir = join(projectPath, '.dork', 'plugins', name, '.dork');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

function buildLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('logOrphanedInstalls', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'orphaned-installs-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('warns once and lists every orphaned package by name', async () => {
    await writeAgentPlugin(projectPath, 'flow', {
      schemaVersion: 1,
      type: 'plugin',
      name: 'flow',
      version: '1.0.0',
    });
    await writeAgentPlugin(projectPath, 'reviewer', {
      schemaVersion: 1,
      type: 'plugin',
      name: 'reviewer',
      version: '2.3.0',
    });

    const logger = buildLogger();
    await logOrphanedInstalls({ projectPath, agentLabel: 'E2E Test Agent', logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, meta] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    const names = (meta.packages as Array<{ name: string }>).map((p) => p.name).sort();
    expect(names).toEqual(['flow', 'reviewer']);
    expect(meta.agent).toBe('E2E Test Agent');
  });

  it('stays silent when the agent has no .dork/plugins directory', async () => {
    const logger = buildLogger();
    await logOrphanedInstalls({ projectPath, agentLabel: 'Bare Agent', logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays silent when .dork/plugins exists but holds no valid package', async () => {
    await mkdir(join(projectPath, '.dork', 'plugins', 'not-a-package'), { recursive: true });
    const logger = buildLogger();
    await logOrphanedInstalls({ projectPath, agentLabel: 'Empty Agent', logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
