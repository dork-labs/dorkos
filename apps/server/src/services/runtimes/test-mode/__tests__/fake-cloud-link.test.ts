import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// env is a plain mutable object at runtime (apps/server/src/env.ts) — mock it
// with a shared, hoisted object so each test can flip DORKOS_TEST_RUNTIME
// without a full module re-import (vi.mock's factory is hoisted above imports;
// vi.hoisted() is what lets it safely close over mockEnv).
const mockEnv = vi.hoisted(() => ({ DORKOS_TEST_RUNTIME: true }));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));

import { createFakeCloudLinkFetch } from '../fake-cloud-link.js';

const CLOUD_LINK_TS = fileURLToPath(new URL('../../../core/auth/cloud-link.ts', import.meta.url));
const CLOUD_LINK_CLIENT_TS = fileURLToPath(
  new URL('../../../core/auth/cloud-link-client.ts', import.meta.url)
);
const ROUTES_CLOUD_TS = fileURLToPath(new URL('../../../../routes/cloud.ts', import.meta.url));

describe('createFakeCloudLinkFetch', () => {
  beforeEach(() => {
    mockEnv.DORKOS_TEST_RUNTIME = true;
  });

  describe('guard', () => {
    it('throws when DORKOS_TEST_RUNTIME is false — the runtime half of unreachability', () => {
      mockEnv.DORKOS_TEST_RUNTIME = false;
      expect(() => createFakeCloudLinkFetch()).toThrow(
        'createFakeCloudLinkFetch is test-mode only (DORKOS_TEST_RUNTIME)'
      );
    });

    it('returns a callable FetchLike when DORKOS_TEST_RUNTIME is true', () => {
      const fetchImpl = createFakeCloudLinkFetch();
      expect(typeof fetchImpl).toBe('function');
    });
  });

  describe('device flow behavior', () => {
    it('device/code returns pinned, deterministic pending content', async () => {
      const fetchImpl = createFakeCloudLinkFetch();
      const res = await fetchImpl('https://dorkos.ai/api/auth/device/code', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        user_code: 'DORK-2F7Q',
        verification_uri: 'https://dorkos.ai/activate',
        interval: 1,
      });
    });

    it('device/token answers authorization_pending for the first PENDING_POLLS_BEFORE_APPROVAL calls, then approves — the offline auto-flip', async () => {
      const fetchImpl = createFakeCloudLinkFetch();
      const poll = () =>
        fetchImpl('https://dorkos.ai/api/auth/device/token', {
          method: 'POST',
          body: JSON.stringify({ device_code: 'dev-1' }),
        });

      const first = await poll();
      expect(first.status).toBe(400);
      expect(await first.json()).toEqual({ error: 'authorization_pending' });

      const second = await poll();
      expect(second.status).toBe(400);
      expect(await second.json()).toEqual({ error: 'authorization_pending' });

      const third = await poll();
      expect(third.status).toBe(200);
      expect(await third.json()).toEqual({ access_token: 'fake-instance-key' });
    });

    it('device/token counting is per device_code — a second, distinct code starts its own count', async () => {
      const fetchImpl = createFakeCloudLinkFetch();
      const pollFor = (deviceCode: string) =>
        fetchImpl('https://dorkos.ai/api/auth/device/token', {
          method: 'POST',
          body: JSON.stringify({ device_code: deviceCode }),
        });

      // Exhaust dev-1's pending budget.
      await pollFor('dev-1');
      await pollFor('dev-1');
      const dev1Third = await pollFor('dev-1');
      expect(dev1Third.status).toBe(200);

      // dev-2 has never been polled — starts back at authorization_pending.
      const dev2First = await pollFor('dev-2');
      expect(dev2First.status).toBe(400);
      expect(await dev2First.json()).toEqual({ error: 'authorization_pending' });
    });

    it('heartbeat returns the pinned accountLabel and a fresh ISO lastSeenAt', async () => {
      const fetchImpl = createFakeCloudLinkFetch();
      const res = await fetchImpl('https://dorkos.ai/api/instances/heartbeat', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accountLabel: string; lastSeenAt: string };
      expect(body.accountLabel).toBe('Dork Labs');
      expect(new Date(body.lastSeenAt).toString()).not.toBe('Invalid Date');
    });

    it('revoke is a best-effort 200 no-op', async () => {
      const fetchImpl = createFakeCloudLinkFetch();
      const res = await fetchImpl('https://dorkos.ai/api/instances/revoke', { method: 'POST' });
      expect(res.status).toBe(200);
    });

    it('an unknown pathname throws — fail loud, never a silent escape', async () => {
      const fetchImpl = createFakeCloudLinkFetch();
      await expect(fetchImpl('https://dorkos.ai/api/unknown', { method: 'POST' })).rejects.toThrow(
        'fake cloud-link: unexpected request /api/unknown'
      );
    });
  });

  describe('import-graph unreachability', () => {
    it('production auth modules never reference the fake module specifier — the structural half of unreachability', () => {
      for (const file of [CLOUD_LINK_TS, CLOUD_LINK_CLIENT_TS, ROUTES_CLOUD_TS]) {
        const source = fs.readFileSync(file, 'utf8');
        expect(source).not.toContain('fake-cloud-link');
      }
    });
  });
});
