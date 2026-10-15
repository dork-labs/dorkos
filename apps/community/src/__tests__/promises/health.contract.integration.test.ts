/**
 * Contract for `/health`, `/health/ready` and `/metrics` (specs/server-merge step 1, DOR-2875):
 * what a load balancer, an orchestrator's probe and a metrics scraper rely on. Metrics need host
 * authority with `communities:read`; the refusals without it are pinned too. A deliberate change
 * updates this file in the same PR and says so in the PR description.
 */
import { z } from 'zod';
import { contractSuite } from './contract.js';
import { asOperator, startSpace, withKey } from './space-fixture.js';

const JSON_TYPE = /^application\/json\b/u;

contractSuite(
  'health and metrics',
  () =>
    startSpace('promises_health', {
      read: ['communities:read'],
      write: ['communities:write'],
    }),
  [
    {
      name: 'GET /health answers ok without touching anything',
      path: '/health',
      expect: { status: 200, headers: { 'content-type': JSON_TYPE }, body: { status: 'ok' } },
    },
    {
      name: 'GET /health/ready answers ok once the database answers, never cached',
      path: '/health/ready',
      expect: {
        status: 200,
        headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store' },
        schema: z.strictObject({
          status: z.literal('ok'),
          database: z.literal('ok'),
          listener: z.string(),
        }),
      },
    },
    {
      name: 'GET /metrics without a credential is refused',
      path: '/metrics',
      expect: { status: 401, match: { code: 'UNAUTHENTICATED' } },
    },
    {
      name: 'GET /metrics with something that is not a host key is refused',
      path: '/metrics',
      headers: { authorization: 'Bearer not-a-key' },
      expect: {
        status: 401,
        body: { code: 'UNAUTHENTICATED', message: 'A valid server API key is required.' },
      },
    },
    {
      name: 'GET /metrics with a well-formed key nobody issued is refused',
      path: '/metrics',
      headers: { authorization: `Bearer dkh_${'A'.repeat(43)}` },
      expect: {
        status: 401,
        body: { code: 'UNAUTHENTICATED', message: 'A valid server API key is required.' },
      },
    },
    {
      name: 'GET /metrics with a key without communities:read is forbidden',
      path: '/metrics',
      headers: withKey('write'),
      expect: {
        status: 403,
        body: { code: 'FORBIDDEN', message: 'This key does not allow that action.' },
      },
    },
    {
      name: 'GET /metrics with communities:read answers Prometheus text, never cached',
      path: '/metrics',
      headers: withKey('read'),
      expect: {
        status: 200,
        headers: {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        },
        text: /^# TYPE community_live_streams gauge$[\s\S]*^# TYPE community_db_pool_waiting gauge$/mu,
      },
    },
    {
      name: "GET /metrics with a host operator's session answers too",
      path: '/metrics',
      headers: asOperator,
      expect: { status: 200, headers: { 'content-type': /^text\/plain\b/u } },
    },
    {
      name: 'POST /health is not a route',
      method: 'POST',
      path: '/health',
      expect: { status: 404 },
    },
  ]
);
