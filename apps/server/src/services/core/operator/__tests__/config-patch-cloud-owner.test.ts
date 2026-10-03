/**
 * A person-approved `config_patch` of the DorkOS account's own settings
 * (`cloud.*`) needs the yes of the owner of this DorkOS when login is on
 * (DOR-2678). Every other operator-only setting keeps going through on any
 * person's yes, and with login off the person bar is the whole answer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const written: Record<string, unknown>[] = [];
const posture = vi.hoisted(() => ({ loginOn: false }));

vi.mock('../config-patch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config-patch.js')>()),
  sanitizedConfigSnapshot: () => ({ version: 1 }),
  applyConfigPatch: (patch: Record<string, unknown>) => {
    written.push(patch);
    return { ok: true, config: { version: 1 }, before: { version: 1 }, warnings: [] };
  },
}));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: posture.loginOn } : undefined),
    getAll: () => ({}),
    onChange: () => () => {},
  },
}));
vi.mock('../../auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_owner', name: 'Owner' }),
}));

import { createConfigPatchHandler } from '../operator-tool-handlers.js';
import { CLOUD_SETTINGS_OWNER_ONLY_MESSAGE } from '../config-write.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/dorkbot',
  displayName: 'DorkBot',
  createdAt: new Date().toISOString(),
};

const CLOUD_PATCH = { patch: { cloud: { credits: { agents: ['agent-1'] } } } };

function approvedBy(decidedByUserId?: string) {
  return createConfigPatchHandler(AGENT, {
    via: 'approval',
    approvalId: 'appr-1',
    ...(decidedByUserId ? { decidedByUserId } : {}),
  });
}

describe('a person-approved change to the DorkOS account settings', () => {
  beforeEach(() => {
    written.length = 0;
    posture.loginOn = false;
  });

  it('with login on, changes nothing on the yes of an account that is not the owner', async () => {
    posture.loginOn = true;
    const result = await approvedBy('user_member')(CLOUD_PATCH);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: 'owner_only',
      message: CLOUD_SETTINGS_OWNER_ONLY_MESSAGE,
      paths: ['cloud.credits.agents'],
    });
    expect(written).toEqual([]);
  });

  it('with login on, changes nothing on a yes nobody can be shown to have given', async () => {
    posture.loginOn = true;
    const result = await approvedBy()(CLOUD_PATCH);
    expect(result.isError).toBe(true);
    expect(written).toEqual([]);
  });

  it('with login on, goes through on the owner’s yes', async () => {
    posture.loginOn = true;
    const result = await approvedBy('user_owner')(CLOUD_PATCH);
    expect(result.isError).toBeUndefined();
    expect(written).toHaveLength(1);
  });

  it('with login on, leaves every other guarded setting to any person’s yes', async () => {
    posture.loginOn = true;
    const result = await approvedBy('user_member')({ patch: { tunnel: { enabled: true } } });
    expect(result.isError).toBeUndefined();
    expect(written).toHaveLength(1);
  });

  it('with login off, goes through on the person’s yes', async () => {
    const result = await approvedBy()(CLOUD_PATCH);
    expect(result.isError).toBeUndefined();
    expect(written).toHaveLength(1);
  });
});
