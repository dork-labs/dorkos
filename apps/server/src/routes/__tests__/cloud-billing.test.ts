/**
 * The billing-page routes, driven end to end against a fake DorkOS account.
 *
 * Nothing between the route and `fetch` is mocked: the route, the billing
 * module, the `/v1` client seam and the contract client all run for real, and
 * the only stand-in is a stubbed `fetch` that answers by `/v1` path and throws
 * on anything else, so no request can leave the machine. The payloads are the
 * contract package's own synthetic fixtures, so no plan name or price is ever
 * written down here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import hostedPageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/hosted-page.json' with { type: 'json' };
import offersFixture from '@dork-labs/cloud-api/fixtures/v1/billing/offers.json' with { type: 'json' };
import offersEmptyFixture from '@dork-labs/cloud-api/fixtures/v1/billing/offers-empty.json' with { type: 'json' };
import refusalFixture from '@dork-labs/cloud-api/fixtures/v1/problem/entitlement-required-action.json' with { type: 'json' };

const config = vi.hoisted(() => ({ cloud: { instanceToken: 'tok_test' } as unknown }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (section: string) => (section === 'cloud' ? config.cloud : undefined),
    onChange: () => () => {},
  },
}));

// The link flow itself is not under test here; only its accessor is imported.
vi.mock('../../services/core/auth/cloud-link.js', () => ({
  getCloudLinkManager: () => ({}),
  getCloudLinkGeneration: () => 0,
}));

import cloudRouter from '../cloud.js';

const app = express();
app.use(express.json());
app.use('/api/cloud', cloudRouter);
const server = listeningServer(app);

/** One request the fake account received. */
interface Seen {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

/** Answer `/v1` requests by path, recording each one; any other path fails the test. */
function fakeAccount(routes: Record<string, { status: number; body: unknown }>) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);
      seen.push({
        method: init?.method ?? 'GET',
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        authorization: headers.get('authorization'),
      });
      const hit = routes[path];
      if (!hit) throw new Error(`unexpected request: ${path}`);
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  return seen;
}

describe('billing-page routes', () => {
  beforeEach(() => {
    config.cloud = { instanceToken: 'tok_test' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('POST /api/cloud/billing/:page', () => {
    it.each([
      ['portal', '/v1/portal'],
      ['topup', '/v1/topup'],
    ])('hands back only the address the service gave for %s', async (page, v1Path) => {
      const seen = fakeAccount({ [v1Path]: { status: 200, body: hostedPageFixture } });
      const res = await request(server).post(`/api/cloud/billing/${page}`).expect(200);
      expect(res.body).toEqual({ ok: true, url: hostedPageFixture.url });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        method: 'POST',
        path: v1Path,
        authorization: 'Bearer tok_test',
      });
      // No amount and no return address: both are the service's to decide.
      expect(seen[0].body).toEqual({});
    });

    it('sends the chosen offer to checkout unchanged', async () => {
      const seen = fakeAccount({ '/v1/checkout': { status: 200, body: hostedPageFixture } });
      const skuId = offersFixture.offers[1].skuId;
      const res = await request(server)
        .post('/api/cloud/billing/checkout')
        .send({ skuId })
        .expect(200);
      expect(res.body).toEqual({ ok: true, url: hostedPageFixture.url });
      expect(seen[0]).toMatchObject({ path: '/v1/checkout', body: { skuId } });
    });

    it('refuses a checkout that names no offer, without asking the service', async () => {
      const seen = fakeAccount({});
      await request(server).post('/api/cloud/billing/checkout').send({}).expect(400);
      expect(seen).toHaveLength(0);
    });

    it('refuses a page it does not know, without asking the service', async () => {
      const seen = fakeAccount({});
      await request(server).post('/api/cloud/billing/refunds').expect(404);
      expect(seen).toHaveLength(0);
    });

    it('says so plainly when this instance is not linked, and sends nothing', async () => {
      config.cloud = undefined;
      const seen = fakeAccount({});
      const res = await request(server).post('/api/cloud/billing/portal').expect(200);
      expect(res.body).toEqual({
        ok: false,
        message: 'This instance is not linked to a DorkOS account.',
      });
      expect(seen).toHaveLength(0);
    });

    it('passes a refusal through in the service`s own words', async () => {
      fakeAccount({ '/v1/portal': { status: 403, body: refusalFixture } });
      const res = await request(server).post('/api/cloud/billing/portal').expect(200);
      expect(res.body).toEqual({ ok: false, problem: refusalFixture });
    });

    it('says the account could not be reached when the service is unwell, echoing nothing', async () => {
      fakeAccount({ '/v1/topup': { status: 502, body: { internal: 'stack trace' } } });
      const res = await request(server).post('/api/cloud/billing/topup').expect(200);
      expect(res.body).toEqual({
        ok: false,
        message: 'Couldn’t reach your DorkOS account. Try again shortly.',
      });
    });

    it.each([
      ['plain http', 'http://pay.example.invalid/page'],
      ['a script', 'javascript:alert(1)'],
    ])('never hands the browser %s as a payment page', async (_label, url) => {
      fakeAccount({ '/v1/portal': { status: 200, body: { url } } });
      const res = await request(server).post('/api/cloud/billing/portal').expect(200);
      expect(res.body.ok).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain(url);
    });
    it('lets a service on this machine answer over plain http, for local development', async () => {
      const url = 'http://localhost:7000/hosted/portal';
      fakeAccount({ '/v1/portal': { status: 200, body: { url } } });
      const res = await request(server).post('/api/cloud/billing/portal').expect(200);
      expect(res.body).toEqual({ ok: true, url });
    });
  });

  describe('GET /api/cloud/offers', () => {
    it('passes the offers through in the order the service sent them', async () => {
      fakeAccount({ '/v1/offers': { status: 200, body: offersFixture } });
      const res = await request(server).get('/api/cloud/offers').expect(200);
      expect(res.body.available).toBe(true);
      expect(res.body.offers.offers.map((o: { skuId: string }) => o.skuId)).toEqual(
        offersFixture.offers.map((o) => o.skuId)
      );
      expect(res.body.offers.denomination).toEqual(offersFixture.denomination);
    });

    it('treats nothing on sale as an ordinary answer', async () => {
      fakeAccount({ '/v1/offers': { status: 200, body: offersEmptyFixture } });
      const res = await request(server).get('/api/cloud/offers').expect(200);
      expect(res.body).toEqual({ available: true, offers: offersEmptyFixture });
    });

    it('hides the offers on an install with no cloud account, asking nothing', async () => {
      config.cloud = undefined;
      const seen = fakeAccount({});
      const res = await request(server).get('/api/cloud/offers').expect(200);
      expect(res.body).toEqual({ available: false });
      expect(seen).toHaveLength(0);
    });

    it('answers 502 when the service is unwell', async () => {
      fakeAccount({ '/v1/offers': { status: 500, body: 'nope' } });
      await request(server).get('/api/cloud/offers').expect(502);
    });
  });
});
