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
  applyApprovedUpdates,
  applyInstalledUpdates,
  checkInstalledUpdates,
  type InstalledUpdatesDeps,
  type ReinstallGateInput,
} from '../../flows/update-installed.js';
import type { InstallationRecord } from '../../installed-scanner.js';

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

describe('checkInstalledUpdates', () => {
  let dorkHome: string;
  let checkInstallations: ReturnType<typeof vi.fn>;
  let deps: InstalledUpdatesDeps;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'update-installed-check-'));
    await stage(path.join(dorkHome, 'plugins', 'alpha'), 'alpha');
    await stage(path.join(dorkHome, 'plugins', 'beta'), 'beta');
    checkInstallations = vi.fn(async () => ({ checks: [] }));
    deps = {
      dorkHome,
      updateFlow: { checkInstallations } as unknown as InstalledUpdatesDeps['updateFlow'],
      onPluginsChanged: vi.fn(),
    };
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('checks only the selected installations, advisory', async () => {
    // Purpose: an advisory check of one package must not fetch every other
    // package's marketplace, and must never apply.
    await checkInstalledUpdates(deps, undefined, { names: ['beta'] });

    const [[req]] = checkInstallations.mock.calls as [
      [{ installations: InstallationRecord[]; apply?: boolean }],
    ];
    expect(req.installations.map((r) => r.package.name)).toEqual(['beta']);
    expect(req.apply).toBeUndefined();
  });

  it('refuses an unknown name before checking anything', async () => {
    // Purpose: a typo must say so, not answer with an empty (all-clear) list.
    await expect(checkInstalledUpdates(deps, undefined, { names: ['nope'] })).rejects.toThrow(
      'Package not installed: nope'
    );
    expect(checkInstallations).not.toHaveBeenCalled();
  });
});

describe('applyApprovedUpdates', () => {
  let dorkHome: string;
  let planInstallations: ReturnType<typeof vi.fn>;
  let applyPlan: ReturnType<typeof vi.fn>;
  let onPluginsChanged: ReturnType<typeof vi.fn<InstalledUpdatesDeps['onPluginsChanged']>>;
  let deps: InstalledUpdatesDeps;
  const disclosed = { hooks: [], schedules: [], mcpServers: [] };

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'update-installed-approved-'));
    await stage(path.join(dorkHome, 'plugins', 'alpha'), 'alpha');
    await stage(path.join(dorkHome, 'plugins', 'beta'), 'beta');
    const alpha = path.join(dorkHome, 'plugins', 'alpha');
    const beta = path.join(dorkHome, 'plugins', 'beta');
    planInstallations = vi.fn(async () => ({
      checks: [
        {
          packageName: 'alpha',
          installPath: alpha,
          type: 'plugin',
          scope: 'global',
          status: 'update-available',
          installedVersion: '1.0.0',
          latestVersion: '2.0.0',
          disclosed,
        },
        {
          packageName: 'beta',
          installPath: beta,
          type: 'plugin',
          scope: 'global',
          status: 'current',
          installedVersion: '1.0.0',
          latestVersion: '1.0.0',
        },
      ],
      steps: [],
    }));
    applyPlan = vi.fn(async () => ({
      checks: [{ packageName: 'alpha', scope: 'global', applied: { packageName: 'alpha' } }],
    }));
    onPluginsChanged = vi.fn<InstalledUpdatesDeps['onPluginsChanged']>();
    deps = {
      dorkHome,
      updateFlow: {
        checkInstallations: vi.fn(),
        planInstallations,
        applyPlan,
      } as unknown as InstalledUpdatesDeps['updateFlow'],
      onPluginsChanged,
    };
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('asks about exactly the stale installations, with what each new version runs', async () => {
    // Purpose: the person approves what will change, not every installed package.
    const gate = vi.fn(async () => undefined);

    await applyApprovedUpdates(deps, {}, gate);

    expect(planInstallations).toHaveBeenCalledWith(expect.objectContaining({ disclose: true }));
    expect(gate).toHaveBeenCalledWith([
      expect.objectContaining({
        packageName: 'alpha',
        installPath: path.join(dorkHome, 'plugins', 'alpha'),
        installedVersion: '1.0.0',
        latestVersion: '2.0.0',
        disclosed,
      }),
    ]);
  });

  it('applies only what was approved, held to what it was shown to run, and refreshes it', async () => {
    const outcome = await applyApprovedUpdates(deps, {}, async () => undefined);

    expect('result' in outcome).toBe(true);
    const [, approved] = applyPlan.mock.calls[0] as [unknown, Map<string, unknown>];
    expect([...approved.entries()]).toEqual([[path.join(dorkHome, 'plugins', 'alpha'), disclosed]]);
    expect(onPluginsChanged).toHaveBeenCalledWith({
      projectPath: undefined,
      packageName: 'alpha',
      action: 'install',
    });
  });

  it('runs nothing when the gate refuses', async () => {
    const outcome = await applyApprovedUpdates(deps, {}, async () => 'no');

    expect(outcome).toEqual({ refused: 'no' });
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('does not ask at all when nothing is stale', async () => {
    // Purpose: a card with nothing on it is a card a person learns to click past.
    planInstallations.mockResolvedValue({ checks: [], steps: [] });
    const gate = vi.fn(async () => undefined);

    const outcome = await applyApprovedUpdates(deps, {}, gate);

    expect(gate).not.toHaveBeenCalled();
    expect(applyPlan).not.toHaveBeenCalled();
    expect(outcome).toEqual({ result: { checks: [] } });
  });
});
