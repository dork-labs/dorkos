/**
 * Contract for the health routes (`routes/health.ts`), the worked example for
 * the contract harness (DOR-2793). The health group moves to Hono in DOR-2797;
 * that PR must pass this file unchanged.
 *
 * It shows the shape every group's file takes: the answers, then the refusals
 * the API chain gives every route (a foreign `Host`, an untrusted `Origin`, a
 * method the group does not serve, an unknown path).
 */
import { HealthResponseSchema } from '@dorkos/shared/schemas';
import { DeepHealthResponseSchema } from '@dorkos/shared/health-schemas';
import { contractSuite, SERVER_ORIGIN } from './harness.js';

const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };

contractSuite('health', [
  {
    name: 'GET /api/health answers the HealthResponse',
    path: '/api/health',
    expect: {
      status: 200,
      headers: {
        // Not the exact string: Express adds `; charset=utf-8`, Hono's `c.json`
        // does not, and both are the same answer.
        'content-type': /^application\/json\b/,
        'x-content-type-options': 'nosniff',
      },
      schema: HealthResponseSchema,
    },
  },
  {
    name: 'HEAD /api/health answers 200 with no body',
    method: 'HEAD',
    path: '/api/health',
    expect: { status: 200, body: '' },
  },
  {
    name: 'GET /api/health/deep answers the DeepHealthResponse',
    path: '/api/health/deep',
    expect: { status: 200, schema: DeepHealthResponseSchema },
  },
  {
    name: 'a trusted browser origin gets the CORS answer',
    path: '/api/health',
    headers: { origin: SERVER_ORIGIN },
    expect: {
      status: 200,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
    },
  },
  {
    // Pinned as it is today, a 500 from the CORS delegate's thrown error, so a
    // move keeps it. A plainer refusal is a change of its own, after the move.
    name: 'an untrusted browser origin is refused',
    path: '/api/health',
    headers: { origin: 'https://evil.example' },
    expect: {
      status: 500,
      headers: { 'access-control-allow-origin': null },
      body: { error: 'Origin https://evil.example not allowed by CORS', code: 'INTERNAL_ERROR' },
    },
  },
  {
    name: 'a foreign Host is refused before the route runs',
    path: '/api/health',
    headers: { host: 'evil.example' },
    expect: {
      status: 403,
      body: {
        error:
          'This instance does not answer to the address "evil.example". If that is how you reach DorkOS, list it in DORKOS_TRUSTED_HOSTS, or turn on login.',
        code: 'HOST_NOT_ALLOWED',
      },
    },
  },
  {
    name: 'POST /api/health is not a route',
    method: 'POST',
    path: '/api/health',
    body: {},
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'an unknown /api path is the API 404',
    path: '/api/health/nope',
    expect: { status: 404, body: NOT_FOUND },
  },
]);
