/**
 * Tests for the all-packages update door's shared steps
 * ({@link applyInstalledUpdates}): one scan, a gate on every reinstall before
 * anything runs, and one refresh per reinstall that landed. The flow is faked;
 * the scan is real, over a temp dorkHome and one agent project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyInstalledUpdates,
  type InstalledUpdatesDeps,
  type ReinstallGateInput,
} from '../../flows/update-installed.js';

/** Write a minimal plugin install at `root`. */
async function stage(root: string, name: string): Promise<void> {
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, type: 'plugin', name, version: '1.0.0' })
  );
}

describe('applyInstalledUpdates', () => {
  let dorkHome: string;
  let agentPath: string;
  let checkInstallations: ReturnType<typeof vi.fn>;
  let onPluginsChanged: ReturnType<typeof vi.fn<InstalledUpdatesDeps['onPluginsChanged']>>;
  let deps: InstalledUpdatesDeps;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'update-installed-home-'));
    agentPath = await mkdtemp(path.join(tmpdir(), 'update-installed-agent-'));
    await stage(path.join(dorkHome, 'plugins', 'alpha'), 'alpha');
    await stage(path.join(dorkHome, 'plugins', 'beta'), 'beta');
    await stage(path.join(agentPath, '.dork', 'plugins', 'alpha'), 'alpha');
    checkInstallations = vi.fn(async () => ({ checks: [] }));
    onPluginsChanged = vi.fn<InstalledUpdatesDeps['onPluginsChanged']>();
    deps = {
      dorkHome,
      listAgentScopes: () => [{ projectPath: agentPath, id: 'a', name: 'Alpha' }],
      updateFlow: { checkInstallations } as unknown as InstalledUpdatesDeps['updateFlow'],
      onPluginsChanged,
    };
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(agentPath, { recursive: true, force: true });
  });

  it('asks the gate about every reinstall, and a later refusal stops the batch unrun', async () => {
    // Purpose: permission is per reinstall. Stopping at the first ALLOWED one
    // would let the rest run without ever being asked.
    const asked: ReinstallGateInput[] = [];
    const outcome = await applyInstalledUpdates(deps, {}, async (input) => {
      asked.push(input);
      return input.name === 'beta' ? 'no' : undefined;
    });

    expect(outcome).toEqual({ refused: 'no' });
    expect(asked.map((i) => i.name)).toEqual(['alpha', 'beta']);
    expect(checkInstallations).not.toHaveBeenCalled();
  });

  it('asks once per package and scope, then refreshes each landed reinstall in its own scope', async () => {
    // Purpose: the gate and the refresh name the scope a reinstall touches —
    // none for global, the agent's project for its copy — and a failed
    // reinstall claims no change.
    checkInstallations.mockResolvedValue({
      checks: [
        { packageName: 'alpha', scope: 'global', applied: { packageName: 'alpha' } },
        { packageName: 'beta', scope: 'global', applyError: 'disk full' },
        { packageName: 'alpha', scope: 'override', agentPath, applied: { packageName: 'alpha' } },
      ],
    });
    const asked: ReinstallGateInput[] = [];

    const outcome = await applyInstalledUpdates(deps, {}, async (input) => {
      asked.push(input);
      return undefined;
    });

    expect('result' in outcome).toBe(true);
    expect(asked).toEqual([
      { name: 'alpha' },
      { name: 'beta' },
      { name: 'alpha', projectPath: agentPath },
    ]);
    expect(checkInstallations).toHaveBeenCalledWith(expect.objectContaining({ apply: true }));
    expect(onPluginsChanged.mock.calls.map(([ctx]) => ctx)).toEqual([
      { projectPath: undefined, packageName: 'alpha', action: 'install' },
      { projectPath: agentPath, packageName: 'alpha', action: 'install' },
    ]);
  });
});
