/**
 * Contract for the last route groups Express served: the embedded terminal's
 * REST half (`POST /api/terminal`, `DELETE /api/terminal/:id`), an agent's
 * Heartbeat page (`GET /api/agents/:id/heartbeat`) and the cheap-checks credit
 * answer (`PUT /api/heartbeats/triage-credits`). They move to Hono in DOR-2818;
 * that PR must pass this file unchanged.
 *
 * The cases run in order against one server: the terminal one opens is the
 * terminal a later case closes.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  type ComposedServer,
  type ContractCase,
} from './harness.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const UNKNOWN_ULID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const API_NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
const HOST_NOT_ALLOWED = {
  error:
    'This instance does not answer to the address "evil.example". If that is how you reach DorkOS, list it in DORKOS_TRUSTED_HOSTS, or turn on login.',
  code: 'HOST_NOT_ALLOWED',
};
const VALIDATION_FAILED = z.object({
  error: z.literal('Validation failed'),
  details: z.object({}).loose(),
});

describe('contract: the terminal and heartbeat routes', () => {
  let server: ComposedServer | undefined;
  beforeAll(async () => {
    server = await bootComposedServer();
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const check = (testCase: ContractCase) => checkContractCase(server!.baseUrl, testCase);

  it.each<ContractCase>([
    {
      name: 'POST /api/terminal with no cwd is refused',
      method: 'POST',
      path: '/api/terminal',
      body: {},
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/terminal with no body at all is refused the same way',
      method: 'POST',
      path: '/api/terminal',
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/terminal outside the boundary is refused',
      method: 'POST',
      path: '/api/terminal',
      body: { cwd: path.parse(REPO_ROOT).root },
      expect: {
        status: 403,
        schema: z.object({ error: z.string(), code: z.literal('OUTSIDE_BOUNDARY') }),
      },
    },
    {
      name: 'POST /api/terminal with a null byte in the cwd is a 400',
      method: 'POST',
      path: '/api/terminal',
      body: { cwd: `${REPO_ROOT}\u0000x` },
      expect: {
        status: 400,
        schema: z.object({ error: z.string(), code: z.literal('NULL_BYTE') }),
      },
    },
    {
      name: 'POST /api/terminal from a foreign Host is refused before the body is read',
      method: 'POST',
      path: '/api/terminal',
      headers: { host: 'evil.example' },
      body: { cwd: REPO_ROOT },
      expect: { status: 403, body: HOST_NOT_ALLOWED },
    },
    {
      name: 'GET /api/terminal is the API 404',
      path: '/api/terminal',
      expect: { status: 404, body: API_NOT_FOUND },
    },
    {
      name: 'DELETE /api/terminal/:id of a terminal that never existed is a 204',
      method: 'DELETE',
      path: '/api/terminal/no-such-terminal',
      expect: { status: 204, body: '' },
    },
    {
      name: 'GET /api/agents/:id/heartbeat of an unknown agent is a 404',
      path: `/api/agents/${UNKNOWN_ULID}/heartbeat`,
      expect: { status: 404, body: { error: 'No agent with that id.', code: 'NOT_FOUND' } },
    },
    {
      name: 'GET /api/agents/:id/heartbeat refuses ?days=0',
      path: `/api/agents/${UNKNOWN_ULID}/heartbeat?days=0`,
      expect: {
        status: 400,
        body: { error: 'days must be a whole number from 1 to 90.', code: 'INVALID_DAYS' },
      },
    },
    {
      name: 'GET /api/agents/:id/heartbeat refuses ?days=91',
      path: `/api/agents/${UNKNOWN_ULID}/heartbeat?days=91`,
      expect: {
        status: 400,
        body: { error: 'days must be a whole number from 1 to 90.', code: 'INVALID_DAYS' },
      },
    },
    {
      name: 'GET /api/agents/:id/heartbeat refuses ?days=abc',
      path: `/api/agents/${UNKNOWN_ULID}/heartbeat?days=abc`,
      expect: {
        status: 400,
        body: { error: 'days must be a whole number from 1 to 90.', code: 'INVALID_DAYS' },
      },
    },
    {
      name: 'GET /api/agents/:id/heartbeat with a trailing slash answers the same',
      path: `/api/agents/${UNKNOWN_ULID}/heartbeat/`,
      expect: { status: 404, body: { error: 'No agent with that id.', code: 'NOT_FOUND' } },
    },
    {
      name: 'POST /api/agents/:id/heartbeat is the API 404',
      method: 'POST',
      path: `/api/agents/${UNKNOWN_ULID}/heartbeat`,
      expect: { status: 404, body: API_NOT_FOUND },
    },
    {
      name: 'PUT /api/heartbeats/triage-credits with no answer is refused',
      method: 'PUT',
      path: '/api/heartbeats/triage-credits',
      body: {},
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'PUT /api/heartbeats/triage-credits with no body at all is refused the same way',
      method: 'PUT',
      path: '/api/heartbeats/triage-credits',
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'PUT /api/heartbeats/triage-credits refuses an answer that is not a boolean',
      method: 'PUT',
      path: '/api/heartbeats/triage-credits',
      body: { useCredits: 'yes' },
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'PUT /api/heartbeats/triage-credits takes Not now',
      method: 'PUT',
      path: '/api/heartbeats/triage-credits',
      body: { useCredits: false },
      expect: { status: 200, body: { useCredits: false } },
    },
    {
      name: 'PUT /api/heartbeats/triage-credits from an agent is refused',
      method: 'PUT',
      path: '/api/heartbeats/triage-credits',
      headers: { 'x-dorkos-agent': 'some-agent-token' },
      body: { useCredits: true },
      expect: { status: 403, schema: z.object({ error: z.string(), code: z.string() }).loose() },
    },
    {
      name: 'GET /api/heartbeats/triage-credits is the API 404',
      path: '/api/heartbeats/triage-credits',
      expect: { status: 404, body: API_NOT_FOUND },
    },
  ])('$name', async (testCase) => {
    await check(testCase);
  });

  it('POST /api/terminal opens a terminal in the boundary, and DELETE closes it', async () => {
    const opened = await fetch(`${server!.baseUrl}/api/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: REPO_ROOT, size: { cols: 80, rows: 24 } }),
    });
    expect(opened.status).toBe(201);
    expect(opened.headers.get('content-type')).toMatch(/^application\/json\b/);
    const { id } = z
      .object({ id: z.string().min(1) })
      .strict()
      .parse(await opened.json());
    await check({
      name: 'close it',
      method: 'DELETE',
      path: `/api/terminal/${id}`,
      expect: { status: 204, body: '' },
    });
  });
});
