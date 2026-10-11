import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { DeepHealthResponseSchema } from '@dorkos/shared/health-schemas';
import { createApp } from '../../app.js';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import type { DeepHealthDeps } from '../../services/observability/deep-health/index.js';

const fixtureTarget = swappableServer();

/** The server's routing, with the deep-health reads a test hands it, if any. */
function serve(deepHealth?: DeepHealthDeps) {
  const admission = new MainRequestAdmission();
  return composedListener(createApp({ admission }), admission, { deepHealth });
}

describe('GET /api/health/deep', () => {
  it('answers 200 with a schema-valid body even when nothing is wired', async () => {
    const res = await request(fixtureTarget.mount(serve())).get('/api/health/deep');

    expect(res.status).toBe(200);
    expect(DeepHealthResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.checks.every((c: { status: string }) => c.status === 'info')).toBe(true);
  });

  it('answers 200 — not 500 — when a check finds something broken', async () => {
    const app = serve({
      dorkHome: '/nonexistent',
      relay: { isAccessControlQuarantined: () => true, listAccessRules: () => [] },
    });

    const res = await request(fixtureTarget.mount(app)).get('/api/health/deep');

    expect(res.status).toBe(200);
    expect(res.body.checks.some((c: { status: string }) => c.status === 'fail')).toBe(true);
  });

  it('answers 200 with the other checks intact when a subsystem throws', async () => {
    const app = serve({
      dorkHome: '/nonexistent',
      relay: {
        isAccessControlQuarantined: () => {
          throw new Error('RelayCore is closed');
        },
        listAccessRules: () => [],
      },
    });

    const res = await request(fixtureTarget.mount(app)).get('/api/health/deep');

    expect(res.status).toBe(200);
    expect(DeepHealthResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.checks).toHaveLength(8);
    expect(res.body.checks[1].label).toContain('Could not run the check');
  });

  it('leaves the liveness probe alone', async () => {
    const res = await request(fixtureTarget.mount(serve())).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).not.toHaveProperty('checks');
  });
});
