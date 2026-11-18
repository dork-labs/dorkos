/**
 * A person's install or update brings new code, so it waits for the owner to
 * confirm it's them (DOR-4355). Uninstalling and checking for updates stay
 * immediate.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import { createMarketplaceRoutes, type MarketplaceRouteDeps } from '../marketplace.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../services/core/capabilities/index.js';
import { marketplaceDomain } from '../../services/marketplace-mcp/marketplace-capabilities.js';
import type { MarketplaceMcpDeps } from '../../services/marketplace-mcp/marketplace-mcp-tools.js';
import type { DisclosedEffects } from '../../services/marketplace/preview/disclosed-effects.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const PACKAGE = 'northwind-pack';

/** What the new version runs: one hook. */
const RUNS: DisclosedEffects = {
  hooks: [{ event: 'Stop', matcher: null, command: 'echo northwind', source: null }],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
  skillCommands: [],
};

describe('marketplace install and update confirmation', () => {
  const dorkHome = mkdtempSync(join(tmpdir(), 'marketplace-install-step-up-'));
  const installPath = join(dorkHome, 'plugins', PACKAGE);
  const installer = {
    preview: vi.fn(),
    install: vi.fn(async () => ({
      ok: true,
      packageName: PACKAGE,
      version: '1.0.0',
      type: 'plugin',
      installPath,
      warnings: [],
    })),
  };
  const uninstallFlow = {
    uninstall: vi.fn(async () => ({
      ok: true,
      packageName: PACKAGE,
      removedFiles: 1,
      preservedData: [],
    })),
  };
  const updateFlow = {
    run: vi.fn(async () => ({ name: PACKAGE, status: 'up-to-date' })),
    // Every installation handed in is stale, at the version and disclosure shown.
    planInstallations: vi.fn(
      async ({ installations }: { installations: { package: Record<string, unknown> }[] }) => ({
        checks: installations.map(({ package: pkg }) => ({
          packageName: pkg.name,
          installPath: pkg.installPath,
          type: pkg.type,
          scope: pkg.scope,
          status: 'update-available',
          installedVersion: '1.0.0',
          latestVersion: '2.0.0',
          disclosed: RUNS,
          contentHash: 'sha256:v2',
        })),
        steps: [],
      })
    ),
    applyPlan: vi.fn(async (plan: { checks: { packageName: string }[] }) => ({
      checks: plan.checks.map((c) => ({ ...c, applied: { packageName: c.packageName } })),
    })),
    clearMemos: vi.fn(),
  };
  const consent = { settle: vi.fn(async () => {}), removed: vi.fn() };
  const registry = composeRegistry([marketplaceDomain], {
    logger: noopLogger,
    marketplaceDeps: {} as MarketplaceMcpDeps,
  });
  const approvals = new ApprovalService(createTestDb());
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/marketplace',
      routes: createMarketplaceRoutes({
        dorkHome,
        installer,
        uninstallFlow,
        updateFlow,
        consent,
        onPluginsChanged: vi.fn(),
        capabilityRegistry: () => registry,
        heldBackCards: { approvals, onGranted: vi.fn() },
      } as unknown as MarketplaceRouteDeps),
    },
  ]);

  beforeAll(() => {
    initCapabilityTierGate({ approvals });
    mkdirSync(join(installPath, '.dork'), { recursive: true });
    writeFileSync(
      join(installPath, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: PACKAGE,
        version: '1.0.0',
        type: 'plugin',
        description: 'Northwind fixture',
        tags: [],
        layers: [],
        requires: [],
        extensions: [],
      })
    );
  });
  afterAll(() => {
    resetCapabilityTierGate();
    rmSync(dorkHome, { recursive: true, force: true });
  });
  beforeEach(() => {
    installer.install.mockClear();
    uninstallFlow.uninstall.mockClear();
    updateFlow.applyPlan.mockClear();
    updateFlow.run.mockClear();
  });

  it.each(['direct', 'own-tunnel'] as const)('holds a person’s install from %s', async (via) => {
    const held = await owner
      .call('post', `/api/marketplace/packages/${PACKAGE}/install`, via)
      .send({ approvedDisclosure: RUNS, approvedContentHash: 'sha256:v1' });
    expect(held.status).toBe(428);
    expect(installer.install).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
      'not-your-action'
    );
    expect(installer.install).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(installer.install).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: PACKAGE, approvedDisclosure: RUNS })
    );
  });

  it('keeps an install from Wi-Fi refused', async () => {
    const res = await owner
      .call('post', `/api/marketplace/packages/${PACKAGE}/install`, 'wifi')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('uninstalls at once', async () => {
    const res = await owner
      .call('post', `/api/marketplace/packages/${PACKAGE}/uninstall`, 'own-tunnel')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(uninstallFlow.uninstall).toHaveBeenCalledOnce();
  });

  it('holds a person’s update, checked against what was shown first', async () => {
    const target = { installPath, latestVersion: '2.0.0', disclosed: RUNS };
    const moved = await owner
      .call('post', '/api/marketplace/updates', 'own-tunnel')
      .send({ apply: true, targets: [{ ...target, contentHash: 'sha256:other' }] });
    expect(moved.status).toBe(409);
    expect(moved.body.heldActionId).toBeUndefined();

    const held = await owner
      .call('post', '/api/marketplace/updates', 'own-tunnel')
      .send({ apply: true, targets: [{ ...target, contentHash: 'sha256:v2' }] });
    expect(held.status).toBe(428);
    expect(updateFlow.applyPlan).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(updateFlow.applyPlan).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(updateFlow.applyPlan).toHaveBeenCalledOnce();
  });

  it('checks one package for updates at once', async () => {
    const res = await owner
      .call('post', `/api/marketplace/packages/${PACKAGE}/update`, 'own-tunnel')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(updateFlow.run).toHaveBeenCalledOnce();
    expect(updateFlow.applyPlan).not.toHaveBeenCalled();
  });
});
