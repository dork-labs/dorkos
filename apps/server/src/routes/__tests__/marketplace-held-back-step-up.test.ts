/**
 * Letting a held-back package run, and keeping an update's leftover files as
 * the person's, both decide which code runs here, so they wait for the owner
 * to confirm it's them (DOR-4355). Refusing a held-back package stays immediate.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { createMarketplaceRoutes, type MarketplaceRouteDeps } from '../marketplace.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import { packageContentHash } from '../../services/marketplace/lib/content-hash.js';
import {
  computeInstalledFiles,
  readInstalledFiles,
  writeInstalledFiles,
} from '../../services/marketplace/lib/records/installed-files.js';
import { verifyInstall } from '../../services/marketplace/lib/integrity/verify-install.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const KEPT_SKILL = '---\nname: kept\ndescription: Kept.\n---\n\nKept.\n';

/** A disclosure that runs nothing, as a decision would carry it. */
const RUNS_NOTHING = {
  hooks: [],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
  skillCommands: [],
};

describe('held-back package and kept files confirmation', () => {
  const dorkHome = mkdtempSync(join(tmpdir(), 'marketplace-held-back-step-up-'));
  const heldBackCards = { approvals: new ApprovalService(createTestDb()), onGranted: vi.fn() };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/marketplace',
      routes: createMarketplaceRoutes({
        dorkHome,
        onPluginsChanged: vi.fn(),
        capabilityRegistry: () => undefined,
        heldBackCards,
      } as unknown as MarketplaceRouteDeps),
    },
  ]);
  afterAll(() => rmSync(dorkHome, { recursive: true, force: true }));
  beforeEach(() => heldBackCards.onGranted.mockClear());

  /** A global plugin that runs one hook nobody approved, recorded as the installer does. */
  async function installHeldBack(name: string): Promise<string> {
    const root = join(dorkHome, 'plugins', name);
    mkdirSync(join(root, '.dork'), { recursive: true });
    writeFileSync(
      join(root, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name,
        version: '1.0.0',
        type: 'plugin',
        description: 'Northwind fixture',
        tags: [],
        layers: [],
        requires: [],
        extensions: [],
      })
    );
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
    );
    writeFileSync(
      join(root, '.dork', 'install-metadata.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        type: 'plugin',
        installedAt: '2026-11-01T00:00:00Z',
        contentHash: await packageContentHash(root),
      })
    );
    return root;
  }

  /** What the held-back listing shows about one package. */
  async function shown(name: string): Promise<{ effects: object; bindsTo: string }> {
    const listed = await owner.call('get', '/api/marketplace/held-back');
    return listed.body.packages.find((p: { name: string }) => p.name === name);
  }

  it('holds letting a held-back package run', async () => {
    await installHeldBack('northwind-held');
    const { effects, bindsTo } = await shown('northwind-held');
    const held = await owner
      .call('post', '/api/marketplace/held-back/northwind-held/decision', 'own-tunnel')
      .send({ decision: 'allow', effects, bindsTo });
    expect(held.status).toBe(428);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(heldBackCards.onGranted).not.toHaveBeenCalled();
    expect(await shown('northwind-held')).toBeDefined();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 204,
    });
    expect(heldBackCards.onGranted).toHaveBeenCalledOnce();
    expect(await shown('northwind-held')).toBeUndefined();
  });

  it('answers a package that is not held back before asking anyone', async () => {
    const res = await owner
      .call('post', '/api/marketplace/held-back/northwind-nowhere/decision', 'own-tunnel')
      .send({ decision: 'allow', effects: RUNS_NOTHING, bindsTo: 'sha256:none' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'northwind-nowhere is not held back.',
      code: 'not_decidable',
    });
  });

  it('refuses a held-back package at once', async () => {
    await installHeldBack('northwind-refused');
    const { effects, bindsTo } = await shown('northwind-refused');
    const res = await owner
      .call('post', '/api/marketplace/held-back/northwind-refused/decision', 'own-tunnel')
      .send({ decision: 'refuse', effects, bindsTo });
    expect(res.status).toBe(204);
    expect(heldBackCards.onGranted).not.toHaveBeenCalled();
  });

  it('holds keeping an update’s leftover files', async () => {
    const root = await installHeldBack('northwind-kept');
    const record = await computeInstalledFiles(root, {
      identity: { name: 'northwind-kept', type: 'plugin' },
      userEditable: [],
      npmRan: false,
    });
    mkdirSync(join(root, 'skills', 'old'), { recursive: true });
    writeFileSync(join(root, 'skills', 'old', 'SKILL.md'), KEPT_SKILL);
    await writeInstalledFiles(root, {
      ...record,
      unproven: { why: 'no-source', files: { 'skills/old/SKILL.md': 'skills/old/SKILL.md' } },
    });
    const integrity = (await verifyInstall(root)) as { unproven?: { keepKey: string } };
    const keepKey = integrity.unproven!.keepKey;

    const held = await owner
      .call('post', '/api/marketplace/packages/northwind-kept/keep-files', 'own-tunnel')
      .send({ keepKey });
    expect(held.status).toBe(428);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect((await readInstalledFiles(root))?.unproven).toBeDefined();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { outcome: 'kept' },
    });
    expect((await readInstalledFiles(root))?.unproven).toBeUndefined();
  });

  it('answers keeping files of a package that is not installed before asking anyone', async () => {
    const res = await owner
      .call('post', '/api/marketplace/packages/northwind-nowhere/keep-files', 'own-tunnel')
      .send({ keepKey: 'k' });
    expect(res.status).toBe(404);
    expect(res.body.heldActionId).toBeUndefined();
  });
});
