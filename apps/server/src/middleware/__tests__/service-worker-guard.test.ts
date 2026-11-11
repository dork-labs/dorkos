/**
 * Only DorkOS's own service worker installs from this origin (DOR-3547,
 * Security M-A). Through the real `/api` chain, so every path is covered,
 * extension routes included.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { initConfigManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { ApiEnv } from '../../http/api-chain.js';
import { DORKOS_SERVICE_WORKER_PATH } from '../service-worker-guard.js';

const target = swappableServer();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-sw-guard-'));
beforeAll(() => {
  initConfigManager(configDir);
  const routes = new Hono<ApiEnv>();
  routes.get('/*', (c) =>
    c.text('self.addEventListener("fetch", () => {})', 200, {
      'content-type': 'text/javascript',
    })
  );
  target.mount(honoGroupListener({ path: '/api/ext', routes }));
});
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('service worker guard', () => {
  it.each(['/api/ext/flow/sw.js', '/api/ext/flow/', '/api/extensions/flow/bundle', '/sw.js.map'])(
    'refuses a worker script fetch for %s',
    async (url) => {
      const res = await request(target.server).get(url).set('service-worker', 'script');
      expect(res.status).toBe(403);
      expect(res.headers['service-worker-allowed']).toBeUndefined();
    }
  );

  it('lets the same path through as an ordinary fetch', async () => {
    const res = await request(target.server).get('/api/ext/flow/sw.js');
    expect(res.status).toBe(200);
  });

  it("lets DorkOS's own worker through", async () => {
    const res = await request(target.server)
      .get(DORKOS_SERVICE_WORKER_PATH)
      .set('service-worker', 'script');
    expect(res.status).not.toBe(403);
  });
});

describe("DorkOS's own service worker", () => {
  // Guard: the day someone gives sw.js a fetch handler, the mini app access
  // page must go straight to the network, or this fails.
  it('intercepts no request, so it never sits in front of the mini app access page', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../client/public/sw.js'),
      'utf8'
    );
    const handlesFetch = /addEventListener\(\s*['"]fetch['"]/u.test(source);
    if (handlesFetch) expect(source).toContain('/connectors/mini-app-access/');
    expect(handlesFetch).toBe(false);
  });
});
