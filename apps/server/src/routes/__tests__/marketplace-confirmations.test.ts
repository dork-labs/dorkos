/**
 * Tests for `POST /api/marketplace/confirmations/:token` — the out-of-band
 * confirmation token approval endpoint that bridges the DorkOS UI to the
 * `TokenConfirmationProvider` issued by the marketplace MCP install/uninstall
 * tools.
 *
 * The route only inspects the singleton in `services/marketplace-mcp/
 * confirmation-registry.ts`; nothing in this test file goes near the real
 * installer, transaction engine, or rollback path. There is therefore no risk
 * of triggering `runTransaction({ rollbackBranch: true })` against the host
 * worktree, and no need to stub `transactionInternal.isGitRepo`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { MarketplaceSourceManager } from '../../services/marketplace/marketplace-source-manager.js';
import { MarketplaceCache } from '../../services/marketplace/marketplace-cache.js';
import type { PackageFetcher } from '../../services/marketplace/package-fetcher.js';
import type { InstallerLike } from '../../services/marketplace/marketplace-installer.js';
import type { UninstallFlow } from '../../services/marketplace/flows/uninstall.js';
import type { UpdateFlow } from '../../services/marketplace/flows/update.js';
import {
  AutoApproveConfirmationProvider,
  TokenConfirmationProvider,
} from '../../services/marketplace-mcp/confirmation-provider.js';
import {
  setMarketplaceConfirmationProvider,
  clearMarketplaceConfirmationProvider,
} from '../../services/marketplace-mcp/confirmation-registry.js';
import { createMarketplaceRouter } from '../marketplace.js';

/**
 * Build a minimal marketplace router app with stubbed dependencies — the
 * confirmation route never touches sourceManager / cache / fetcher / installer
 * / uninstallFlow / updateFlow, so we hand it the bare minimum needed for the
 * factory to construct.
 */
function buildApp(dorkHome: string): express.Express {
  const sourceManager = new MarketplaceSourceManager(dorkHome);
  const cache = new MarketplaceCache(dorkHome);
  const fetcher = {
    fetchMarketplaceJson: vi.fn(),
  } as unknown as PackageFetcher;
  const installer: InstallerLike = {
    preview: vi.fn(),
    install: vi.fn(),
  };
  const uninstallFlow = { uninstall: vi.fn() } as unknown as UninstallFlow;
  const updateFlow = { run: vi.fn() } as unknown as UpdateFlow;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/marketplace',
    createMarketplaceRouter({
      sourceManager,
      cache,
      fetcher,
      installer,
      uninstallFlow,
      updateFlow,
      dorkHome,
    })
  );
  return app;
}

describe('POST /api/marketplace/confirmations/:token', () => {
  let dorkHome: string;
  let app: express.Express;

  beforeEach(() => {
    dorkHome = mkdtempSync(join(tmpdir(), 'dorkos-marketplace-confirmations-'));
    app = buildApp(dorkHome);
    // Reset the singleton between tests so test ordering can never leak state.
    clearMarketplaceConfirmationProvider();
  });

  afterEach(() => {
    clearMarketplaceConfirmationProvider();
    rmSync(dorkHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns 400 when the body is missing the action field', async () => {
    setMarketplaceConfirmationProvider(new TokenConfirmationProvider());

    const res = await request(app).post('/api/marketplace/confirmations/some-token').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeTruthy();
  });

  it('returns 400 when the action is not approve or decline', async () => {
    setMarketplaceConfirmationProvider(new TokenConfirmationProvider());

    const res = await request(app)
      .post('/api/marketplace/confirmations/some-token')
      .send({ action: 'maybe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 503 when no confirmation provider has been registered', async () => {
    // beforeEach already cleared the singleton — assert the cleared state.
    const res = await request(app)
      .post('/api/marketplace/confirmations/some-token')
      .send({ action: 'approve' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Confirmation provider not available');
  });

  it('returns 409 when the active provider is not a TokenConfirmationProvider', async () => {
    setMarketplaceConfirmationProvider(new AutoApproveConfirmationProvider());

    const res = await request(app)
      .post('/api/marketplace/confirmations/some-token')
      .send({ action: 'approve' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Server not configured for out-of-band confirmations');
  });

  it('approves the token via the provider when action=approve', async () => {
    const provider = new TokenConfirmationProvider();
    const approveSpy = vi.spyOn(provider, 'approve');
    setMarketplaceConfirmationProvider(provider);

    const res = await request(app)
      .post('/api/marketplace/confirmations/abc-123')
      .send({ action: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledWith('abc-123');
  });

  it('declines the token via the provider when action=decline', async () => {
    const provider = new TokenConfirmationProvider();
    const declineSpy = vi.spyOn(provider, 'decline');
    setMarketplaceConfirmationProvider(provider);

    const res = await request(app)
      .post('/api/marketplace/confirmations/xyz-789')
      .send({ action: 'decline', reason: 'no thanks' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(declineSpy).toHaveBeenCalledTimes(1);
    expect(declineSpy).toHaveBeenCalledWith('xyz-789', 'no thanks');
  });

  it('declines the token without a reason when reason is omitted', async () => {
    const provider = new TokenConfirmationProvider();
    const declineSpy = vi.spyOn(provider, 'decline');
    setMarketplaceConfirmationProvider(provider);

    const res = await request(app)
      .post('/api/marketplace/confirmations/xyz-789')
      .send({ action: 'decline' });

    expect(res.status).toBe(200);
    expect(declineSpy).toHaveBeenCalledWith('xyz-789', undefined);
  });

  it('round-trips a real approve through resolveToken', async () => {
    const provider = new TokenConfirmationProvider();
    setMarketplaceConfirmationProvider(provider);

    // Issue a real token through the provider so we can verify the route's
    // approve call actually flips the resolution state end-to-end.
    const issued = await provider.requestInstallConfirmation({
      packageName: 'sample-plugin',
      marketplace: 'dorkos-community',
      operation: 'install',
    });
    expect(issued.status).toBe('pending');
    if (issued.status !== 'pending') throw new Error('expected pending');

    const res = await request(app)
      .post(`/api/marketplace/confirmations/${issued.token}`)
      .send({ action: 'approve' });
    expect(res.status).toBe(200);

    const resolved = await provider.resolveToken(issued.token);
    expect(resolved.status).toBe('approved');
  });

  it('round-trips a real decline through resolveToken with the reason intact', async () => {
    const provider = new TokenConfirmationProvider();
    setMarketplaceConfirmationProvider(provider);

    const issued = await provider.requestInstallConfirmation({
      packageName: 'sample-plugin',
      marketplace: 'dorkos-community',
      operation: 'install',
    });
    if (issued.status !== 'pending') throw new Error('expected pending');

    const res = await request(app)
      .post(`/api/marketplace/confirmations/${issued.token}`)
      .send({ action: 'decline', reason: 'looks sketchy' });
    expect(res.status).toBe(200);

    const resolved = await provider.resolveToken(issued.token);
    expect(resolved.status).toBe('declined');
    if (resolved.status === 'declined') {
      expect(resolved.reason).toBe('looks sketchy');
    }
  });
});
