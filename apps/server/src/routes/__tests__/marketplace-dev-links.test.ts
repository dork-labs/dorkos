/**
 * The `/api/marketplace/dev-links` routes and the `marketplace.link` gate
 * (DOR-2696 task 1.4), over the real capability registry, approval service and
 * dev-link service, against a temp folder.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentPermissions } from '@dorkos/shared/permissions';
import { createMarketplaceRouter } from '../marketplace.js';
import { initBoundary } from '../../lib/boundary.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import {
  authorizeCapability,
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../services/core/capabilities/permission-enforcement.js';
import { marketplaceDomain } from '../../services/marketplace-mcp/marketplace-capabilities.js';
import type { MarketplaceMcpDeps } from '../../services/marketplace-mcp/marketplace-mcp-tools.js';
import {
  DevLinkService,
  type DevLinkApprovals,
} from '../../services/marketplace/dev-links/index.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import { memoryConsentStore } from '../../services/marketplace/dev-links/__tests__/memory-consent-store.js';

const target = swappableServer();
const server = target.server;

let base: string;
let home: string;
let work: string;
let approvals: ApprovalService;
let registry: CapabilityRegistry;
let agentHeader: string | undefined;
let extensionApprovals: DevLinkApprovals;

async function writePackage(dir: string, name = 'flow'): Promise<void> {
  await mkdir(path.join(dir, '.dork'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'plugin' })
  );
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-routes-')));
  home = path.join(base, 'dork-home');
  work = path.join(base, 'work', 'flow');
  await mkdir(home, { recursive: true });
  await writePackage(work);
  await initBoundary(base);
  initConfigManager(home);
  agentHeader = undefined;
  extensionApprovals = { approvedToRun: [], approvedSources: {} };
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  approvals = new ApprovalService(createTestDb());
  initCapabilityTierGate({ approvals });
  registry = composeRegistry([marketplaceDomain], {
    logger: noopLogger,
    marketplaceDeps: {} as MarketplaceMcpDeps,
  });
  const devLinks = new DevLinkService({
    consent: memoryConsentStore(),
    dorkHome: home,
    approvals: {
      read: () => extensionApprovals,
      write: (next) => {
        extensionApprovals = next;
      },
    },
    onPluginsChanged: () => undefined,
    refreshExtensions: () => undefined,
    boundary: () => base,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (agentHeader) req.headers['x-dorkos-agent'] = agentHeader;
    next();
  });
  app.use(
    '/api/marketplace',
    createMarketplaceRouter({
      dorkHome: home,
      capabilityRegistry: () => registry,
      onPluginsChanged: () => undefined,
      devLinks,
    } as unknown as MarketplaceRouteDeps)
  );
  target.mount(app);
});

afterEach(async () => {
  resetCapabilityTierGate();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

const slot = () => path.join(home, 'plugins', 'flow');

describe('POST /api/marketplace/dev-links', () => {
  it('links for the person, recording where they linked from', async () => {
    // Purpose: the person in the app is not asked to approve their own click.
    const res = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: work, scope: 'global', via: 'terminal' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'flow', state: 'active', path: work });
    expect(await readlink(slot())).toBe(work);
  });

  it('gives an agent an approval card naming the folder, and links nothing', async () => {
    // Purpose: only a person creates a dev link; the card shows the full path.
    agentHeader = 'agent-token';
    const res = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: work, scope: 'global' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'approval_required',
      capabilityId: 'marketplace.link',
    });
    const detail = approvals.listPending()[0]?.detail ?? '';
    expect(detail).toContain(`Folder: ${work}`);
    expect(detail).toContain('Extensions it may run: none');
    await expect(readlink(slot())).rejects.toThrow();
  });

  it('runs an approved retry with the same input, and refuses one with a different folder', async () => {
    // Purpose: the yes binds to the exact folder; a token for one folder must
    // never link another.
    agentHeader = 'agent-token';
    const first = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: work, scope: 'global' });
    approvals.grant(first.body.approvalId as string);

    const other = path.join(base, 'other', 'flow');
    await writePackage(other);
    const swapped = await request(server)
      .post('/api/marketplace/dev-links')
      .set('x-dorkos-approval', first.body.approvalToken as string)
      .send({ path: other, scope: 'global' });
    expect(swapped.status).not.toBe(201);
    await expect(readlink(slot())).rejects.toThrow();

    const same = await request(server)
      .post('/api/marketplace/dev-links')
      .set('x-dorkos-approval', first.body.approvalToken as string)
      .send({ path: work, scope: 'global' });
    expect(same.status).toBe(201);
    expect(await readlink(slot())).toBe(work);
  });

  it('voids an approval when the folder gains an extension between the card and the retry', async () => {
    // Purpose: the yes covers the extensions the card showed. One added after
    // the card must not ride in on it, approved without anybody seeing it.
    agentHeader = 'agent-token';
    const first = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: work, scope: 'global' });
    approvals.grant(first.body.approvalId as string);
    const added = path.join(work, '.dork', 'extensions', 'sneaky');
    await mkdir(added, { recursive: true });
    await writeFile(path.join(added, 'extension.json'), '{"id":"sneaky"}');

    const retry = await request(server)
      .post('/api/marketplace/dev-links')
      .set('x-dorkos-approval', first.body.approvalToken as string)
      .send({ path: work, scope: 'global' });
    expect(retry.status).toBe(202);
    await expect(readlink(slot())).rejects.toThrow();
    expect(extensionApprovals.approvedToRun).toEqual([]);
  });

  it('refuses a project outside the boundary before raising any card', async () => {
    // Purpose: a person must never be asked about a link that would be refused.
    agentHeader = 'agent-token';
    const res = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: work, scope: 'project', projectPath: '/definitely/not/inside' });
    expect(res.status).toBe(403);
    expect(approvals.listPending()).toEqual([]);
  });

  it('answers an over-long path with 400, not a 500', async () => {
    // Purpose: the capability caps the path; the route must refuse the same
    // input cleanly instead of failing the input parse inside the gate.
    const res = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: `/${'a'.repeat(5000)}`, scope: 'global' });
    expect(res.status).toBe(400);
  });

  it('refuses a body whose scope and project disagree', async () => {
    // Purpose: a project link without its project would land in the global slot.
    const res = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: work, scope: 'project' });
    expect(res.status).toBe(400);
  });

  it('answers a refusal with its code and sentence', async () => {
    // Purpose: the app shows the sentence inline; the CLI and agents read the code.
    const empty = path.join(base, 'empty');
    await mkdir(empty);
    const res = await request(server)
      .post('/api/marketplace/dev-links')
      .send({ path: empty, scope: 'global' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'No package found in this folder.',
      code: 'dev_link_not_a_package',
    });
  });
});

describe('POST /api/marketplace/dev-links/preview', () => {
  it('says what linking would do, and changes nothing', async () => {
    // Purpose: the dialog previews on blur; a preview that linked would be a
    // link without a yes.
    const res = await request(server)
      .post('/api/marketplace/dev-links/preview')
      .send({ path: work, scope: 'global' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'flow', path: work, slot: slot(), replaces: null });
    await expect(readlink(slot())).rejects.toThrow();
  });

  it('refuses an unknown field', async () => {
    // Purpose: the body is strict, so a typo is not silently a different request.
    const res = await request(server)
      .post('/api/marketplace/dev-links/preview')
      .send({ path: work, scope: 'global', replace: true });
    expect(res.status).toBe(400);
  });
});

describe('GET and unlink', () => {
  it('lists, refuses an agent unlink, and lets the person unlink', async () => {
    // Purpose: unlinking changes which code runs, so it is the person's alone.
    await request(server).post('/api/marketplace/dev-links').send({ path: work, scope: 'global' });
    const listed = await request(server).get('/api/marketplace/dev-links');
    expect(listed.body.links).toEqual([expect.objectContaining({ name: 'flow', state: 'active' })]);

    agentHeader = 'agent-token';
    const refused = await request(server)
      .post('/api/marketplace/dev-links/flow/unlink')
      .send({ scope: 'global' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('operator_only');
    expect(await readlink(slot())).toBe(work);

    agentHeader = undefined;
    const done = await request(server)
      .post('/api/marketplace/dev-links/flow/unlink')
      .send({ scope: 'global' });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ restored: 'removed' });
  });

  it('refuses a name that is not a package name', async () => {
    // Purpose: the name is joined into a slot path.
    const res = await request(server)
      .post('/api/marketplace/dev-links/..%2Fetc/unlink')
      .send({ scope: 'global' });
    expect(res.status).toBe(400);
  });
});

describe('the marketplace.link gate and permission settings', () => {
  const agent = { agentPath: '/agents/scout', displayName: 'Scout', createdAt: '2026-10-03' };
  let agentPermissions: AgentPermissions;

  beforeEach(() => {
    initPermissionGate({
      readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => agentPermissions,
    });
  });

  afterEach(() => resetPermissionGate());

  it('asks every time, even after an Always allow on the action', async () => {
    // Purpose: `area: null` means no setting can pre-approve a dev link. The
    // control below shows the same Always allow DOES let an area-carrying
    // destructive action run, so this would go green-to-red if
    // `marketplace.link` were ever given an area.
    agentPermissions = {
      actions: { 'marketplace.link': 'allowed', 'marketplace.uninstall': 'allowed' },
    } as AgentPermissions;

    const link = await authorizeCapability(
      registry,
      'marketplace.link',
      { path: work },
      { identity: agent, retryChannel: 'http-header' },
      { change: `Folder: ${work}` }
    );
    expect(link.outcome).toBe('approval_required');

    const control = await authorizeCapability(
      registry,
      'marketplace.uninstall',
      { name: 'flow' },
      { identity: agent, retryChannel: 'http-header' }
    );
    expect(control.outcome).toBe('allowed');
  });
});
