import { describe, it, expect, afterEach, vi } from 'vitest';

// The `/api` chain reads config (login, the host allowlist); nothing is set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { runtimeSettingsReader } from '../runtime-settings-reader.js';
import {
  runtimeReadsDomain,
  setRuntimeSettingsReader,
} from '../../services/core/runtime-doors/runtime-read-capabilities.js';
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../services/core/usage/current-usage-store.js';

// The capability mount serves the read (`runtimes.account_usage`, DOR-4978).
setRuntimeSettingsReader(runtimeSettingsReader());
const server = listeningServer(honoGroupListener(capabilityGroup(runtimeReadsDomain)));

const usage = { runtime: 'codex', accountId: 'default' } as AccountUsage;

describe('GET /api/runtimes/:type/accounts/usage (spec claude-account-fleet D2)', () => {
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
    expect(res.body.detail).toBe('Account usage is not available yet.');
  });

  it('is the person’s own: an agent is refused', async () => {
    setAccountUsageStore({
      list: vi.fn().mockReturnValue([usage]),
    } as unknown as AccountUsageStore);
    const res = await request(server)
      .get('/api/runtimes/codex/accounts/usage')
      .set('X-DorkOS-Agent', 'agent-1');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
  });
});
