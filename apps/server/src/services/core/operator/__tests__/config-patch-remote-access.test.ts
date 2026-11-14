/**
 * The `config_patch` tool never turns Remote Access on, not even with a
 * person's yes on a card, and may always turn it off (Security, DOR-3650).
 * Pinned at the tool itself, so taking the rule out of the handler turns this
 * red even while the rule's own module still holds it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const written: Record<string, unknown>[] = [];

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
    get: (key: string) => (key === 'auth' ? { enabled: false } : undefined),
    getAll: () => ({}),
    onChange: () => () => {},
  },
}));

import { createConfigPatchHandler } from '../operator-tool-handlers.js';
import { PERSON_TURNS_ON_ONLY_CODE } from '../operator-only-tightening.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/scout',
  displayName: 'Scout',
  createdAt: new Date().toISOString(),
};

const ON = { patch: { remoteAccess: { enabled: true } } };
const OFF = { patch: { remoteAccess: { enabled: false } } };

/** The tool after a person said yes to this exact call on a card. */
const approved = () => createConfigPatchHandler(AGENT, { via: 'approval', approvalId: 'appr-1' });

describe('config_patch and Remote Access', () => {
  beforeEach(() => {
    written.length = 0;
  });

  it('never turns it on, even with a person yes on a card', async () => {
    const result = await approved()(ON);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: PERSON_TURNS_ON_ONLY_CODE,
      paths: ['remoteAccess.enabled'],
    });
    expect(written).toEqual([]);
  });

  it('never turns it on without a card either', async () => {
    const result = await createConfigPatchHandler(AGENT)(ON);
    expect(result.isError).toBe(true);
    expect(written).toEqual([]);
  });

  it('turns it off on a person yes', async () => {
    const result = await approved()(OFF);
    expect(result.isError).toBeUndefined();
    expect(written).toEqual([OFF.patch]);
  });

  it('turns it off on its own at Full, where only turning a setting down runs unasked', async () => {
    const result = await createConfigPatchHandler(AGENT, {
      via: 'permission',
      source: 'floor',
    })(OFF);
    expect(result.isError).toBeUndefined();
    expect(written).toEqual([OFF.patch]);
  });
});
