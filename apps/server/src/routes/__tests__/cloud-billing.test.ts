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
import exportFixture from '@dork-labs/cloud-api/fixtures/v1/session/account-export.json' with { type: 'json' };

const config = vi.hoisted(() => ({ cloud: { instanceToken: 'tok_test' } as unknown }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (section: string) => (section === 'cloud' ? config.cloud : undefined),
    onChange: () => () => {},
  },
}));

// Where this instance reaches its DorkOS account. A real https origin by
// default; a test that needs a service on this machine says so.
const cloud = vi.hoisted(() => ({ baseUrl: 'https://account.example.invalid' }));
vi.mock('../../services/core/auth/cloud-link-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/cloud-link-client.js')>()),
  resolveCloudBaseUrl: () => cloud.baseUrl,
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
    cloud.baseUrl = 'https://account.example.invalid';
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
      ['a data address', 'data:text/html,<script>alert(1)</script>'],
      [
        'plain http on this machine, to an account that is not on this machine',
        'http://localhost:7000/hosted/portal',
      ],
    ])('never hands the browser %s as a payment page', async (_label, url) => {
      fakeAccount({ '/v1/portal': { status: 200, body: { url } } });
      const res = await request(server).post('/api/cloud/billing/portal').expect(200);
      expect(res.body.ok).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain(url);
    });

    it('lets a service on this machine answer over plain http, for local development', async () => {
      cloud.baseUrl = 'http://localhost:7000';
      const url = 'http://localhost:7000/hosted/portal';
      fakeAccount({ '/v1/portal': { status: 200, body: { url } } });
      const res = await request(server).post('/api/cloud/billing/portal').expect(200);
      expect(res.body).toEqual({ ok: true, url });
    });

    it('hands on the address as the URL parser reads it', async () => {
      fakeAccount({
        '/v1/portal': { status: 200, body: { url: 'HTTPS://Pay.Example.Invalid/a b' } },
      });
      const res = await request(server).post('/api/cloud/billing/portal').expect(200);
      expect(res.body).toEqual({ ok: true, url: 'https://pay.example.invalid/a%20b' });
    });

    // The service answers "not found" the same way whether it does not serve
    // the route or cannot find what the request named, so each action gets one
    // sentence that is true either way, for every shape that answer can take.
    const NOT_FOUND_ANSWERS = [
      [
        'a not-found problem',
        {
          code: 'not_found',
          status: 404,
          title: 'Developer prose',
          detail: 'Developer prose about a route.',
        },
      ],
      ['a bare 404', 'Not Found'],
    ] as const;

    describe.each([
      ['portal', '/v1/portal', 'Billing isn’t available on your account yet.'],
      ['checkout', '/v1/checkout', 'That plan isn’t available right now.'],
      ['topup', '/v1/topup', 'Adding credits isn’t available on your account yet.'],
    ])('a not-found answer to %s', (page, v1Path, sentence) => {
      it.each(NOT_FOUND_ANSWERS)(
        'reads as one plain sentence, never the service`s own prose, for %s',
        async (_shape, body) => {
          fakeAccount({ [v1Path]: { status: 404, body } });
          const res = await request(server)
            .post(`/api/cloud/billing/${page}`)
            .send({ skuId: 'sku_opaque_0001' })
            .expect(200);
          expect(res.body).toEqual({ ok: false, message: sentence });
        }
      );
    });
  });

  describe('POST /api/cloud/account/export', () => {
    it('asks for the export and says it is still being prepared while it has no link', async () => {
      const seen = fakeAccount({ '/v1/account/export': { status: 200, body: exportFixture } });
      const res = await request(server).post('/api/cloud/account/export').expect(200);
      expect(res.body).toEqual({
        ok: true,
        export: { requestedAt: exportFixture.requestedAt, readyAt: null, downloadUrl: null },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(seen[0]).toMatchObject({
        method: 'POST',
        path: '/v1/account/export',
        body: { notifyEmail: true },
        authorization: 'Bearer tok_test',
      });
    });

    it('passes on the download link once the export is ready', async () => {
      const ready = {
        ...exportFixture,
        readyAt: '2026-09-15T12:05:00.000Z',
        downloadUrl: 'https://files.example.invalid/exp_0001',
      };
      fakeAccount({ '/v1/account/export': { status: 200, body: ready } });
      const res = await request(server).post('/api/cloud/account/export').expect(200);
      expect(res.body.export).toEqual({
        requestedAt: ready.requestedAt,
        readyAt: ready.readyAt,
        downloadUrl: ready.downloadUrl,
      });
    });

    it('drops a download link this app would not open, so the export reads as not ready', async () => {
      const ready = {
        ...exportFixture,
        readyAt: '2026-09-15T12:05:00.000Z',
        downloadUrl: 'http://files.example.invalid/x',
      };
      fakeAccount({ '/v1/account/export': { status: 200, body: ready } });
      const res = await request(server).post('/api/cloud/account/export').expect(200);
      expect(res.body.export).toMatchObject({ readyAt: null, downloadUrl: null });
    });

    it.each([
      ['a not-found problem', { code: 'not_found', status: 404, title: 'Developer prose' }],
      ['a bare 404', 'Not Found'],
    ])('says exporting is not available on the account for %s', async (_shape, body) => {
      fakeAccount({ '/v1/account/export': { status: 404, body } });
      const res = await request(server).post('/api/cloud/account/export').expect(200);
      expect(res.body).toEqual({
        ok: false,
        message: 'Exporting your data isn’t available on your account yet.',
      });
    });

    it('passes any other refusal through in the service`s own words', async () => {
      fakeAccount({ '/v1/account/export': { status: 403, body: refusalFixture } });
      const res = await request(server).post('/api/cloud/account/export').expect(200);
      expect(res.body).toEqual({ ok: false, problem: refusalFixture });
    });

    it('sends nothing while this instance is not linked', async () => {
      config.cloud = undefined;
      const seen = fakeAccount({});
      const res = await request(server).post('/api/cloud/account/export').expect(200);
      expect(res.body).toEqual({
        ok: false,
        message: 'This instance is not linked to a DorkOS account.',
      });
      expect(seen).toHaveLength(0);
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
