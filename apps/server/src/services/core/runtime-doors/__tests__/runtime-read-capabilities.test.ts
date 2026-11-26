/**
 * The app's runtime setup reads on the capability mount (DOR-4978): who may
 * read them, where from, and that no answer or refusal carries a secret.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { noopLogger } from '@dorkos/shared/logger';
import type { CapabilityHandlerContext, CapabilityRequestFacts } from '../../capabilities/index.js';
import { capabilityGroup } from '../../../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { initConfigManager } from '../../config-manager.js';
import {
  runtimeReadsDomain,
  setRuntimeSettingsReader,
  type RuntimeSettingsReader,
} from '../runtime-read-capabilities.js';

const SECRET = 'sk-fixture-never-echo-9f3a';

/** A reader whose every answer is secret-free, and whose failure carries a private path. */
const reader: RuntimeSettingsReader = {
  accountUsage: () => [],
  foundAccounts: () => [],
  accountEligibility: async () => ({ project: null, allow: null, accounts: [] }),
  runtimeKeyStatus: async () => ({ key: { saved: true, last4: SECRET.slice(-4) } }),
  openCodeKeySetup: vi.fn(async () => {
    throw new Error(`/Users/fixture/.dork/keys ${SECRET}`);
  }),
  doeInference: () => ({ inference: null, hasKey: true, autoProtocol: null }),
};

/** Every read's path, with the query it needs. */
const READS = [
  '/api/runtimes/claude-code/accounts/usage',
  '/api/runtimes/claude-code/accounts/found',
  '/api/runtimes/claude-code/account-eligibility',
  '/api/runtimes/claude-code/credential',
  '/api/runtimes/opencode/provider',
  '/api/runtimes/doe/inference',
];

const server = listeningServer(honoGroupListener(capabilityGroup(runtimeReadsDomain)));

// The `/api` chain reads config (login, the host allowlist): a fresh one, in a throwaway home.
let dorkHome: string;
beforeAll(() => {
  dorkHome = mkdtempSync(join(tmpdir(), 'dork-runtime-reads-'));
  initConfigManager(dorkHome);
  setRuntimeSettingsReader(reader);
});
afterAll(() => {
  setRuntimeSettingsReader(undefined);
  rmSync(dorkHome, { recursive: true, force: true });
});

describe('the runtime setup reads', () => {
  it('are person-only: an agent and a bearer are refused on every path', async () => {
    for (const path of READS) {
      for (const [header, value] of [
        ['X-DorkOS-Agent', 'agent-1'],
        ['Authorization', 'Bearer fixture-token'],
      ] as const) {
        const res = await request(server).get(path).set(header, value);
        expect([path, res.status, res.body.code]).toEqual([path, 403, 'person_only']);
      }
    }
  });

  it('answer a person, and a saved key only by its last four characters', async () => {
    const res = await request(server).get('/api/runtimes/claude-code/credential');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: { saved: true, last4: SECRET.slice(-4) } });
    expect(res.text).not.toContain(SECRET);
  });

  it('answer a failed read with the fixed sentence, never its detail', async () => {
    const res = await request(server).get('/api/runtimes/opencode/provider');
    expect(res.status).toBe(500);
    expect(res.body.detail).toBe('Could not read your saved settings.');
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain('/Users/fixture');
  });

  it('answer a failed model setup read with its fixed sentence', async () => {
    setRuntimeSettingsReader({
      ...reader,
      doeInference: () => {
        throw new Error(`/Users/fixture/.dork/config.json ${SECRET}`);
      },
    });
    try {
      const res = await request(server).get('/api/runtimes/doe/inference');
      expect(res.status).toBe(500);
      expect(res.body.detail).toBe('Could not read your model setup.');
      expect(res.text).not.toContain('/Users/fixture');
    } finally {
      setRuntimeSettingsReader(reader);
    }
  });

  it('refuse a person away from this computer for a key or model read, as the hand routes did', async () => {
    const away = {
      request: { atThisComputerWithoutProgramKey: false } as CapabilityRequestFacts,
    } as CapabilityHandlerContext;
    for (const [id, input, sentence] of [
      ['runtimes.key_status', { type: 'claude-code' }, 'Runtime connect actions'],
      ['runtimes.opencode_key_setup', {}, 'Runtime connect actions'],
      ['runtimes.doe_model_setup', {}, 'Model setup'],
    ] as const) {
      const capability = runtimeReadsDomain.capabilities.find((each) => each.id === id)!;
      await expect(
        Promise.resolve().then(() => capability.invoke({ logger: noopLogger }, input, away))
      ).rejects.toMatchObject({
        payload: { code: 'RUNTIMES_NOT_LOCAL', error: expect.stringContaining(sentence) },
      });
    }
  });
});
