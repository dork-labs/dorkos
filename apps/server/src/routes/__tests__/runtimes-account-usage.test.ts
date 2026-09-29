import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import runtimesRouter from '../runtimes.js';
import type { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../services/core/usage/current-usage-store.js';

const app = express();
app.use('/api/runtimes', runtimesRouter);
const server = listeningServer(app);

const usage = { runtime: 'codex', accountId: 'default' } as AccountUsage;

describe('GET /api/runtimes/:runtime/accounts/usage (spec claude-account-fleet D2)', () => {
  afterEach(() => setAccountUsageStore(undefined));

  it("serves the runtime's accounts from the store", async () => {
    const list = vi.fn().mockReturnValue([usage]);
    setAccountUsageStore({ list } as unknown as AccountUsageStore);
    const res = await request(server).get('/api/runtimes/codex/accounts/usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: [usage] });
    expect(list).toHaveBeenCalledWith('codex');
  });

  it('refuses an unknown runtime with a 400', async () => {
    setAccountUsageStore({ list: vi.fn() } as unknown as AccountUsageStore);
    const res = await request(server).get('/api/runtimes/test-mode/accounts/usage');
    expect(res.status).toBe(400);
  });

  it('answers 503 before the store is running', async () => {
    const res = await request(server).get('/api/runtimes/claude-code/accounts/usage');
    expect(res.status).toBe(503);
  });
});
