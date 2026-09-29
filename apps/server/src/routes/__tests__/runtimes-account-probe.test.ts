import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import runtimesRouter from '../runtimes.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import type { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../services/core/usage/current-usage-store.js';
import type { RuntimeAccount } from '../../services/core/usage/runtime-accounts.js';
import { resetAccountProbeState } from '../../services/runtimes/claude-code/accounts/account-probe.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';

const app = express();
app.use('/api/runtimes', runtimesRouter);
const server = listeningServer(app);

const usage = { runtime: 'claude-code', accountId: 'work', state: 'unknown' } as AccountUsage;

/** A registered account whose folder does not exist, so the probe never starts the CLI. */
const work = {
  runtime: 'claude-code',
  id: 'work',
  path: '/nonexistent/claude-work',
  implicit: false,
  isDefault: false,
  routable: true,
} as RuntimeAccount;

function installStore(accounts: RuntimeAccount[]) {
  const store = {
    listAccounts: vi.fn().mockReturnValue(accounts),
    usageOfAccount: vi.fn().mockReturnValue(usage),
    record: vi.fn(),
  };
  setAccountUsageStore(store as unknown as AccountUsageStore);
  return store;
}

describe('POST /api/runtimes/claude-code/accounts/:id/probe (spec claude-account-fleet D3)', () => {
  beforeEach(() => {
    // The route asks the config whether login is on before anything else.
    const dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-probe-route-'));
    fs.writeFileSync(path.join(dorkHome, 'config.json'), JSON.stringify({}), 'utf-8');
    initConfigManager(dorkHome);
  });

  afterEach(() => {
    setAccountUsageStore(undefined);
    resetAccountProbeState();
  });

  it('answers 200 with the account and how the probe went, recording nothing on a failure', async () => {
    const store = installStore([work]);
    const res = await request(server).post('/api/runtimes/claude-code/accounts/work/probe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account: usage, probe: 'failed', reason: 'not-an-account' });
    expect(store.record).not.toHaveBeenCalled();
  });

  it('answers 404 UNKNOWN_ACCOUNT for an id nobody registered', async () => {
    installStore([work]);
    const res = await request(server).post('/api/runtimes/claude-code/accounts/nobody/probe');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');
  });

  it('refuses a caller that names itself an agent, and starts nothing', async () => {
    const store = installStore([work]);
    const res = await request(server)
      .post('/api/runtimes/claude-code/accounts/work/probe')
      .set(AGENT_IDENTITY_HEADER, 'any-agent-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERSON_ONLY');
    expect(store.listAccounts).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it('answers 503 before the usage store is running', async () => {
    const res = await request(server).post('/api/runtimes/claude-code/accounts/work/probe');
    expect(res.status).toBe(503);
  });
});
