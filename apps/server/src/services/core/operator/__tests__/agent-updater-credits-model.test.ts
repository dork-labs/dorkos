/**
 * The agent-reachable write path (`PATCH /api/agents/current` and the
 * `update_agent` MCP tool both land in `updateAgentManifest`) refuses a model
 * DorkOS credits do not cover for an agent that runs on them (DOR-2636), with
 * the same rule the operator's route applies.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

vi.mock('../../cloud/credits-model-gate.js', () => ({
  creditsAgentModelRefusal: vi.fn(async (opts: { model: string; account?: string | null }) =>
    opts.account === 'dorkos-credits' && opts.model === 'opus'
      ? 'DorkOS credits don’t cover that model. Pick one from the model menu.'
      : null
  ),
}));

import { creditsAgentModelRefusal } from '../../cloud/credits-model-gate.js';
import { AgentUpdateError, updateAgentManifest } from '../agent-updater.js';

let agentPath: string;
const SEED = {
  id: '01M054RMQAMZPXHWHRKPGY9Z87',
  name: 'warden',
  description: 'Watches the build.',
  runtime: 'claude-code',
  account: 'dorkos-credits',
  capabilities: [],
  registeredAt: '2026-08-16T00:00:00.000Z',
  registeredBy: 'test',
  isSystem: false,
} as unknown as AgentManifest;

beforeEach(async () => {
  agentPath = await mkdtemp(join(tmpdir(), 'agent-updater-credits-'));
  await mkdir(join(agentPath, '.dork'), { recursive: true });
  await writeManifest(agentPath, SEED);
});
afterEach(async () => {
  await rm(agentPath, { recursive: true, force: true });
});

describe('updateAgentManifest on DorkOS credits', () => {
  it('refuses a model credits do not cover, writing nothing', async () => {
    const err = await updateAgentManifest({ agentPath, body: { model: 'opus' } }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(AgentUpdateError);
    expect((err as AgentUpdateError).code).toBe('UNSUPPORTED_MODEL');
    expect((await readManifest(agentPath))?.model).toBeUndefined();
    // Judged against the account already on file: an agent cannot name its own.
    expect(creditsAgentModelRefusal).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: SEED.id,
        account: 'dorkos-credits',
        accountNamedNow: false,
      })
    );
  });

  it('stores a model credits cover', async () => {
    const updated = await updateAgentManifest({ agentPath, body: { model: 'md_pick' } });
    expect(updated.model).toBe('md_pick');
  });
});
