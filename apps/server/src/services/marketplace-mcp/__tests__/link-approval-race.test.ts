/**
 * `marketplace_link` links exactly what the person approved (DOR-2696): the
 * handler acts on the description the gate let through, never a fresh read of
 * the folder, so an extension added after the gate passed is not approved.
 *
 * @vitest-environment node
 */
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import { initConfigManager } from '../../core/config-manager.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../core/capabilities/index.js';
import { DevLinkService, type DevLinkApprovals } from '../../marketplace/dev-links/index.js';
import { marketplaceDomain } from '../marketplace-capabilities.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';

let base: string;
let home: string;
let work: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'link-race-')));
  home = path.join(base, 'dork-home');
  work = path.join(base, 'work', 'flow');
  await mkdir(path.join(work, '.dork'), { recursive: true });
  await writeFile(
    path.join(work, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'flow', version: '1.0.0', type: 'plugin' })
  );
  await mkdir(home, { recursive: true });
  initConfigManager(home);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});

afterEach(async () => {
  resetCapabilityTierGate();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

describe('marketplace.link after the gate passes', () => {
  it('does not link a folder that gained an extension after the person approved it', async () => {
    // Purpose: between the gate letting the approved call through and the
    // link, the folder gains an extension. Re-reading the folder there would
    // describe it with the new extension and approve it unseen; holding the
    // link to the approved text refuses it.
    let approvals: DevLinkApprovals = { approvedToRun: [], approvedSources: {} };
    const service = new DevLinkService({
      dorkHome: home,
      approvals: { read: () => approvals, write: (next) => void (approvals = next) },
      onPluginsChanged: () => undefined,
      refreshExtensions: () => undefined,
      boundary: () => base,
    });
    // The gate describes the folder once per call. The 2nd read is the
    // retry's gate check; right after it returns (the gate then passes), the
    // folder gains an extension.
    let reads = 0;
    const realDescribe = service.describeApproval.bind(service);
    const devLinks = Object.assign(Object.create(service) as DevLinkService, {
      describeApproval: async (...args: Parameters<DevLinkService['describeApproval']>) => {
        reads += 1;
        const described = await realDescribe(...args);
        if (reads === 2) {
          const added = path.join(work, '.dork', 'extensions', 'sneaky');
          await mkdir(added, { recursive: true });
          await writeFile(path.join(added, 'extension.json'), '{"id":"sneaky"}');
        }
        return described;
      },
      link: service.link.bind(service),
    });
    const gate = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals: gate });
    const registry = composeRegistry([marketplaceDomain], {
      logger: noopLogger,
      marketplaceDeps: { devLinks } as unknown as MarketplaceMcpDeps,
    });
    const agent = { agentPath: '/agents/scout', displayName: 'Scout', createdAt: '2026-10-03' };

    const first = await registry
      .invoke('marketplace.link', { path: work }, { identity: agent, retryChannel: 'mcp-argument' })
      .catch(
        (err: { decision: { payload: { approvalId: string; approvalToken: string } } }) => err
      );
    const { approvalId, approvalToken } = (
      first as { decision: { payload: { approvalId: string; approvalToken: string } } }
    ).decision.payload;
    expect(gate.listPending()[0]?.detail).toContain('Extensions it may run: none');
    gate.grant(approvalId);

    const retry = registry.invoke(
      'marketplace.link',
      { path: work },
      { identity: agent, approvalToken, retryChannel: 'mcp-argument' }
    );
    await expect(retry).rejects.toMatchObject({
      payload: { code: 'dev_link_changed' },
    });
    await expect(lstat(path.join(home, 'plugins', 'flow'))).rejects.toThrow();
    expect(approvals.approvedToRun).toEqual([]);
  });
});
