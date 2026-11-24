/**
 * @vitest-environment node
 *
 * Checking for updates: `POST /packages/:name/update` (one package, advisory
 * only) and `GET /updates` (every installation, scanned once).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

// The update doors must scan every scope ONCE per request, so the one record
// scan is wrapped in a spy that still runs the real walk.
vi.mock('../../../services/marketplace/installed-scanner.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../services/marketplace/installed-scanner.js')>();
  return { ...actual, scanInstallationRecords: vi.fn(actual.scanInstallationRecords) };
});

import { scanInstallationRecords } from '../../../services/marketplace/installed-scanner.js';
import {
  GitCommitNotFoundError,
  GitFetchError,
  GitRefNotFoundError,
  GitRemoteUnreachableError,
} from '../../../services/marketplace/lib/git/git-tree.js';
import {
  buildSamplePluginManifest,
  useMarketplaceRoutes,
  writePackageManifest,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

describe('POST /packages/:name/update', () => {
  const update = (body: object = {}, name = 'sample-plugin') =>
    h.post(`/packages/${name}/update`, body);

  // The route answers 404 for a name installed in no scope before the flow
  // runs, so the package these cases update has to exist on disk.
  beforeEach(() => {
    writePackageManifest(join(h.dorkHome, 'plugins', 'sample-plugin'), {
      ...buildSamplePluginManifest(),
    });
  });

  it('returns the advisory check result, reinstalling nothing', async () => {
    const check = {
      packageName: 'sample-plugin',
      installedVersion: '1.0.0',
      latestVersion: '1.1.0',
      hasUpdate: true,
      marketplace: 'dorkos-community',
    };
    h.updateFlow.run.mockResolvedValue({ checks: [check] });

    const res = await update();

    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual([check]);
    expect(h.updateFlow.run.mock.calls[0][0]).toMatchObject({
      name: 'sample-plugin',
      installation: { package: { scope: 'global' } },
    });
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });

  it('returns 404 for a name installed in no scope at all, without running the check', async () => {
    // It used to fall through to a 500.
    const res = await update({}, 'ghost-plugin');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Package not installed: ghost-plugin');
    expect(h.updateFlow.run).not.toHaveBeenCalled();
  });

  it('runs the check for a name installed only in the requested project', async () => {
    // Found by nothing but the project scan; it must reach the flow, not 404.
    const projectDir = join(h.dorkHome, 'plain-project');
    writePackageManifest(join(projectDir, '.dork', 'plugins', 'project-only'), {
      ...buildSamplePluginManifest(),
      name: 'project-only',
    });
    h.updateFlow.run.mockResolvedValue({ checks: [] });

    const res = await update({ projectPath: projectDir }, 'project-only');

    expect(res.status).toBe(200);
    expect(h.updateFlow.run.mock.calls[0][0]).toMatchObject({
      name: 'project-only',
      installation: { package: { scope: 'agent-local', agentPath: projectDir } },
    });
  });

  it('finds an install whose manifest name is not a package name by its directory, as the flow does', async () => {
    writePackageManifest(join(h.dorkHome, 'plugins', 'honest-plugin'), {
      ...buildSamplePluginManifest(),
      name: '../../../../etc/cron.d',
    });
    h.updateFlow.run.mockResolvedValue({ checks: [] });

    const res = await update({}, 'honest-plugin');

    expect(res.status).toBe(200);
    expect(h.updateFlow.run).toHaveBeenCalledTimes(1);
  });

  it("runs the check for a name installed only in another scope, so it can answer 'not in this scope'", async () => {
    const agentDir = join(h.dorkHome, 'agent-project');
    writePackageManifest(join(agentDir, '.dork', 'plugins', 'agent-only'), {
      ...buildSamplePluginManifest(),
      name: 'agent-only',
    });
    h.agentScopes = [{ projectPath: agentDir, id: 'a1', name: 'Agent' }];
    const unknown = {
      packageName: 'agent-only',
      installedVersion: '',
      latestVersion: '',
      hasUpdate: false,
      marketplace: '',
      status: 'unknown',
      note: 'not installed in this scope',
    };
    h.updateFlow.run.mockResolvedValue({ checks: [unknown] });

    const res = await update({ projectPath: join(h.dorkHome, 'other-project') }, 'agent-only');

    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual([unknown]);
  });

  it("answers git's own failures with honest statuses and plain messages, not a 500", async () => {
    const url = 'https://github.com/dork-labs/marketplace.git';
    const cases: [Error, number][] = [
      [new GitRefNotFoundError('release', url), 404],
      [new GitCommitNotFoundError('a'.repeat(40), url), 404],
      [new GitRemoteUnreachableError(url, 'connection timed out'), 502],
      [new GitFetchError(url, 'the fetched tree did not match its commit'), 502],
    ];
    for (const [error, status] of cases) {
      h.updateFlow.run.mockRejectedValueOnce(error);
      const res = await update();
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: error.message });
    }
  });

  it('returns 403 when projectPath is outside the boundary', async () => {
    const res = await update({ projectPath: '/etc/evil' });

    expect(res.status).toBe(403);
    expect(h.updateFlow.run).not.toHaveBeenCalled();
  });
});

describe('GET /updates', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = join(h.dorkHome, 'agent-alpha');
    writePackageManifest(join(h.dorkHome, 'plugins', 'sample-plugin'), {
      ...buildSamplePluginManifest(),
    });
    writePackageManifest(join(agentDir, '.dork', 'plugins', 'sample-plugin'), {
      ...buildSamplePluginManifest(),
    });
    h.agentScopes = [{ projectPath: agentDir, id: 'alpha', name: 'Alpha' }];
    h.updateFlow.planInstallations.mockResolvedValue({ checks: [], steps: [] });
  });

  it('scans every scope once and checks what it found, saying what each new version runs', async () => {
    // One scan, not one per package; a read that never reinstalls; and every
    // check discloses what its new version runs, which an apply sends back (DOR-2306).
    const result = { checks: [{ packageName: 'sample-plugin', status: 'current' }] };
    h.updateFlow.planInstallations.mockResolvedValue({ ...result, steps: [] });

    const res = await h.get('/updates');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(vi.mocked(scanInstallationRecords)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scanInstallationRecords)).toHaveBeenCalledWith(h.dorkHome, {
      agents: h.agentScopes,
    });
    const [arg] = h.updateFlow.planInstallations.mock.calls[0]!;
    expect(arg.disclose).toBe(true);
    expect(arg.installations.map((r: { package: { scope: string } }) => r.package.scope)).toEqual([
      'global',
      'override',
    ]);
    expect(h.updateFlow.applyPlan).not.toHaveBeenCalled();
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });

  it('refuses projectPath given twice, for both the updates and the installed list', async () => {
    // A repeated key used to be dropped silently and answer for every scope.
    for (const path of ['/updates', '/installed']) {
      expect((await h.get(`${path}?projectPath=/a&projectPath=/b`)).status).toBe(400);
    }
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
  });

  it('lists and checks a symlinked project at the same, canonical install paths', async () => {
    // The Installed view joins rows to checks by installPath, so the two must
    // scan the project at the path the boundary resolved, whatever was sent.
    const realProject = join(h.dorkHome, 'real-project');
    mkdirSync(realProject);
    writePackageManifest(join(realProject, '.dork', 'plugins', 'linked-view'), {
      ...buildSamplePluginManifest(),
      name: 'linked-view',
    });
    const link = join(h.dorkHome, 'link-to-project');
    symlinkSync(realProject, link);

    const listed = await h.get(`/installed?projectPath=${encodeURIComponent(link)}`);
    await h.get(`/updates?projectPath=${encodeURIComponent(link)}`);

    expect(vi.mocked(scanInstallationRecords)).toHaveBeenCalledWith(h.dorkHome, {
      projectPath: realProject,
    });
    const row = listed.body.packages.find((p: { name: string }) => p.name === 'linked-view');
    expect(row.installPath).toBe(join(realProject, '.dork', 'plugins', 'linked-view'));
    const [arg] = h.updateFlow.planInstallations.mock.calls[0]!;
    expect(
      arg.installations.map((r: { package: { installPath: string } }) => r.package.installPath)
    ).toContain(row.installPath);
  });

  it('returns 403 and checks nothing when projectPath is outside the boundary', async () => {
    const res = await h.get('/updates?projectPath=/etc/evil');

    expect(res.status).toBe(403);
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
  });
});
