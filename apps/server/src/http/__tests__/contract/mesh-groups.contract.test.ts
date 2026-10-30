/**
 * Contract for the agent registry route groups, which move to Hono together
 * in DOR-2801: the mesh (`/api/mesh`), agent identity (`/api/agents`), the
 * discovery scan stream (`/api/discovery`), and the two groups that share the
 * `/api/agents` prefix, the managed-MCP sign-in landing
 * (`/api/agents/mcp-oauth`) and an agent's promises
 * (`/api/agents/:id/commitments`, with their list at `/api/commitments`).
 * That PR must pass this file unchanged.
 *
 * Two servers, both with login off:
 *
 * 1. Nothing seeded: the shapes, the validation answers, the 404s, the
 *    boundary refusals and the refusals a caller earns with headers alone (an
 *    agent header it never minted). Also that the pause routes, which already
 *    answer under `/api/agents` from the Hono app, still answer there.
 * 2. Driven by hand, because what it is asked depends on the ids the server
 *    hands out: an agent created, read, changed, registered and removed; the
 *    system agent's protections; a real agent token refused where only a
 *    person may act; denying and clearing a folder through the encoded-path
 *    route; and the discovery stream, with its headers and its events.
 *
 * Everything this file writes goes under the git-ignored `.temp/` at the
 * repository root (the server's directory boundary) and is removed afterwards.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentManifestSchema,
  MeshStatusSchema,
  TopologyViewSchema,
  AgentPauseListSchema,
} from '@dorkos/shared/mesh-schemas';
import { CommitmentSchema, ListCommitmentsResponseSchema } from '@dorkos/shared/commitment-schemas';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
} from './harness.js';

/** The repository root: the composed server's directory boundary. */
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
);
/** The folder every hand-driven case creates its agents in, git-ignored. */
const WORK = path.join(REPO_ROOT, '.temp', `contract-mesh-${randomUUID().slice(0, 8)}`);
mkdirSync(WORK, { recursive: true });
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
const AGENT_NOT_FOUND = { error: 'Agent not found' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
/** A ULID nothing in a fresh install has. */
const UNKNOWN_ULID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const VALIDATION_FAILED = z.object({ error: z.literal('Validation failed') }).loose();
const BOUNDARY_REFUSAL = z.object({ error: z.string(), code: z.string() }).strict();
const NEEDS_APPROVAL = z.object({ error: z.string(), code: z.literal('NEEDS_APPROVAL') }).strict();
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const AGENT_LIST = z.object({ agents: z.array(z.object({ id: z.string() }).loose()) }).strict();
const EVENT_STREAM = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no',
};

contractSuite('mesh, agent and discovery groups', [
  // mesh: reads
  {
    name: 'GET /api/mesh/status reports the registry',
    path: '/api/mesh/status',
    expect: { status: 200, headers: JSON_TYPE, schema: MeshStatusSchema.strict() },
  },
  {
    name: 'HEAD /api/mesh/status answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/mesh/status',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/mesh/agents lists the agents, the system agent among them',
    path: '/api/mesh/agents',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({
        agents: z
          .array(z.object({ isSystem: z.boolean().optional() }).loose())
          .refine((agents) => agents.some((agent) => agent.isSystem === true)),
      }),
    },
  },
  {
    name: 'GET /api/mesh/agents/ answers with a trailing slash',
    path: '/api/mesh/agents/?runtime=claude-code',
    expect: { status: 200, schema: AGENT_LIST },
  },
  {
    name: 'GET /api/mesh/agents refuses a runtime it does not know',
    path: '/api/mesh/agents?runtime=not-a-runtime',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /api/mesh/agents/paths lists the agents with their folders',
    path: '/api/mesh/agents/paths',
    expect: {
      status: 200,
      schema: z.object({ agents: z.array(z.object({ projectPath: z.string() }).loose()) }),
    },
  },
  {
    name: 'GET /api/mesh/agents/:id answers 404 for an unknown agent',
    path: `/api/mesh/agents/${UNKNOWN_ULID}`,
    expect: { status: 404, headers: JSON_TYPE, body: AGENT_NOT_FOUND },
  },
  {
    name: 'HEAD /api/mesh/agents/:id answers 404 with no body',
    method: 'HEAD',
    path: `/api/mesh/agents/${UNKNOWN_ULID}`,
    expect: { status: 404, body: '' },
  },
  {
    name: 'GET /api/mesh/agents/:id/health answers 404 for an unknown agent',
    path: `/api/mesh/agents/${UNKNOWN_ULID}/health`,
    expect: { status: 404, body: AGENT_NOT_FOUND },
  },
  {
    name: 'GET /api/mesh/agents/:id/access answers 404 for an unknown agent',
    path: `/api/mesh/agents/${UNKNOWN_ULID}/access`,
    expect: { status: 404, body: AGENT_NOT_FOUND },
  },
  {
    name: 'GET /api/mesh/agents/:id/nothing is the /api 404',
    path: `/api/mesh/agents/${UNKNOWN_ULID}/nothing`,
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /api/mesh/topology answers the whole mesh',
    path: '/api/mesh/topology',
    expect: { status: 200, schema: TopologyViewSchema },
  },
  {
    name: 'GET /api/mesh/topology/ answers one namespace with a trailing slash',
    path: '/api/mesh/topology/?namespace=nobody',
    expect: { status: 200, schema: TopologyViewSchema },
  },
  {
    name: 'GET /api/mesh/denied lists no denied folders',
    path: '/api/mesh/denied',
    expect: { status: 200, body: { denied: [] } },
  },
  {
    name: 'GET /api/mesh/nothing is the /api 404',
    path: '/api/mesh/nothing',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /api/mesh is the /api 404',
    path: '/api/mesh',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /api/mesh/deny is the /api 404',
    path: '/api/mesh/deny',
    expect: { status: 404, body: NOT_FOUND },
  },

  // mesh: writes refused
  {
    name: 'POST /api/mesh/discover refuses a body with no roots',
    method: 'POST',
    path: '/api/mesh/discover',
    body: { roots: [] },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/mesh/discover refuses a root outside the boundary',
    method: 'POST',
    path: '/api/mesh/discover',
    body: { roots: ['/'] },
    expect: { status: 403, body: { error: 'Path outside boundary: /' } },
  },
  {
    name: 'POST /api/mesh/discover refuses malformed JSON as the chain does',
    method: 'POST',
    path: '/api/mesh/discover',
    headers: { 'content-type': 'application/json' },
    body: '{"roots":',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /api/mesh/agents refuses an empty body',
    method: 'POST',
    path: '/api/mesh/agents',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/mesh/agents refuses a path outside the boundary',
    method: 'POST',
    path: '/api/mesh/agents',
    body: { path: '/', overrides: { name: 'x', runtime: 'claude-code' } },
    expect: { status: 403, body: { error: 'Path outside boundary: /' } },
  },
  {
    name: 'POST /api/mesh/agents refuses a new folder with no name or runtime',
    method: 'POST',
    path: '/api/mesh/agents',
    body: { path: REPO_ROOT + '/.temp' },
    expect: {
      status: 400,
      body: {
        error:
          'overrides.name and overrides.runtime are required to register a directory that has ' +
          'no .dork/agent.json of its own',
      },
    },
  },
  {
    name: 'POST /api/mesh/agents refuses a scan root that is not an ancestor',
    method: 'POST',
    path: '/api/mesh/agents',
    body: { path: REPO_ROOT + '/.temp', scanRoot: REPO_ROOT + '/apps' },
    expect: {
      status: 400,
      body: { error: `Scan root must be an ancestor of the agent path: ${REPO_ROOT}/apps` },
    },
  },
  {
    name: 'PATCH /api/mesh/agents/:id refuses a permission field by name',
    method: 'PATCH',
    path: `/api/mesh/agents/${UNKNOWN_ULID}`,
    body: { permissions: {}, tierCeiling: 'act' },
    expect: {
      status: 400,
      body: {
        error:
          'Only a person can change permissions, from the Permissions page. Agents can ask the person.',
        code: 'USE_PERMISSIONS_API',
        fields: ['permissions', 'tierCeiling'],
      },
    },
  },
  {
    name: 'PATCH /api/mesh/agents/:id refuses a field of the wrong type',
    method: 'PATCH',
    path: `/api/mesh/agents/${UNKNOWN_ULID}`,
    body: { name: 42 },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/mesh/agents/:id answers 404 for an unknown agent',
    method: 'PATCH',
    path: `/api/mesh/agents/${UNKNOWN_ULID}`,
    body: { description: 'nobody' },
    expect: { status: 404, body: AGENT_NOT_FOUND },
  },
  {
    name: 'PATCH /api/mesh/agents/:id refuses an agent changing a model',
    method: 'PATCH',
    path: `/api/mesh/agents/${UNKNOWN_ULID}`,
    headers: AGENT,
    body: { model: 'some-model' },
    expect: { status: 403, schema: NEEDS_APPROVAL },
  },
  {
    name: 'POST /api/mesh/agents/:id/heartbeat answers 404 for an unknown agent',
    method: 'POST',
    path: `/api/mesh/agents/${UNKNOWN_ULID}/heartbeat`,
    expect: { status: 404, body: AGENT_NOT_FOUND },
  },
  {
    name: 'DELETE /api/mesh/agents/:id answers 404 for an unknown agent',
    method: 'DELETE',
    path: `/api/mesh/agents/${UNKNOWN_ULID}`,
    expect: { status: 404, body: AGENT_NOT_FOUND },
  },
  {
    name: 'DELETE /api/mesh/agents/:id/data answers 404 for an unknown agent',
    method: 'DELETE',
    path: `/api/mesh/agents/${UNKNOWN_ULID}/data`,
    expect: { status: 404, body: AGENT_NOT_FOUND },
  },
  {
    name: 'PUT /api/mesh/topology/access refuses a wildcard on one side',
    method: 'PUT',
    path: '/api/mesh/topology/access',
    body: { sourceNamespace: '*', targetNamespace: 'team', action: 'allow' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/mesh/deny refuses a body with no path',
    method: 'POST',
    path: '/api/mesh/deny',
    body: { reason: 'nothing' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/mesh/deny refuses a path outside the boundary',
    method: 'POST',
    path: '/api/mesh/deny',
    body: { path: '/' },
    expect: { status: 403, body: { error: 'Path outside boundary: /' } },
  },
  {
    name: 'DELETE /api/mesh/denied/:encodedPath refuses an encoded dot-dot walk',
    method: 'DELETE',
    path: `/api/mesh/denied/${encodeURIComponent(`${REPO_ROOT}/../outside`)}`,
    expect: { status: 400, body: { error: 'Invalid path' } },
  },
  {
    name: 'DELETE /api/mesh/denied/:encodedPath refuses an encoded path outside the boundary',
    method: 'DELETE',
    path: `/api/mesh/denied/${encodeURIComponent('/')}`,
    expect: { status: 403, body: { error: 'Path outside boundary: /' } },
  },
  {
    name: 'DELETE /api/mesh/denied/:encodedPath decodes a twice-encoded path',
    method: 'DELETE',
    path: `/api/mesh/denied/${encodeURIComponent(encodeURIComponent('/'))}`,
    expect: { status: 403, body: { error: 'Path outside boundary: /' } },
  },
  {
    name: 'DELETE /api/mesh/denied/ with no path is the /api 404',
    method: 'DELETE',
    path: '/api/mesh/denied/',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'DELETE /api/mesh/denied/a/b is the /api 404: the path is one segment',
    method: 'DELETE',
    path: '/api/mesh/denied/a/b',
    expect: { status: 404, body: NOT_FOUND },
  },

  // agents
  {
    name: 'GET /api/agents/current refuses a request with no path',
    path: '/api/agents/current',
    expect: { status: 400, headers: JSON_TYPE, body: { error: 'path query parameter required' } },
  },
  {
    name: 'HEAD /api/agents/current answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/agents/current',
    expect: { status: 400, body: '' },
  },
  {
    name: 'GET /api/agents/current/ refuses a path outside the boundary with a trailing slash',
    path: '/api/agents/current/?path=/',
    expect: { status: 403, schema: BOUNDARY_REFUSAL },
  },
  {
    name: 'GET /api/agents/current answers null for a folder with no agent',
    path: `/api/agents/current?path=${encodeURIComponent(REPO_ROOT + '/apps')}`,
    expect: { status: 200, headers: JSON_TYPE, body: null },
  },
  {
    name: 'POST /api/agents/resolve refuses an empty list',
    method: 'POST',
    path: '/api/agents/resolve',
    body: { paths: [] },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/agents/resolve answers null for folders with no agent, inside or out',
    method: 'POST',
    path: '/api/agents/resolve',
    body: { paths: [REPO_ROOT + '/apps', '/'] },
    expect: { status: 200, body: { agents: { [REPO_ROOT + '/apps']: null, '/': null } } },
  },
  {
    name: 'POST /api/agents refuses an empty body',
    method: 'POST',
    path: '/api/agents',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/agents refuses a path outside the boundary',
    method: 'POST',
    path: '/api/agents',
    body: { path: '/', name: 'outside' },
    expect: { status: 403, schema: BOUNDARY_REFUSAL },
  },
  {
    name: 'POST /api/agents/ refuses malformed JSON as the chain does, with a trailing slash',
    method: 'POST',
    path: '/api/agents/',
    headers: { 'content-type': 'application/json' },
    body: '{"path":',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /api/agents/create refuses a template and a package together',
    method: 'POST',
    path: '/api/agents/create',
    body: { template: 'x', package: {} },
    expect: {
      status: 400,
      body: { error: 'Send a template or a package to create the agent from, not both.' },
    },
  },
  {
    name: 'POST /api/agents/create refuses an agent creating from a package',
    method: 'POST',
    path: '/api/agents/create',
    headers: AGENT,
    body: { package: { name: 'some-agent' } },
    expect: { status: 403, schema: z.object({ code: z.literal('operator_only') }).loose() },
  },
  {
    name: 'POST /api/agents/create refuses a confirmation token that is not text',
    method: 'POST',
    path: '/api/agents/create',
    body: { name: 'x', confirmationToken: 42 },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/agents/current refuses a request with no path',
    method: 'PATCH',
    path: '/api/agents/current',
    body: { description: 'x' },
    expect: { status: 400, body: { error: 'path query parameter required' } },
  },
  {
    name: 'PATCH /api/agents/current refuses an agent changing a runtime, before the path',
    method: 'PATCH',
    path: '/api/agents/current',
    headers: AGENT,
    body: { runtime: 'codex' },
    expect: { status: 403, schema: NEEDS_APPROVAL },
  },
  {
    name: 'PATCH /api/agents/current answers 404 for a folder with no agent',
    method: 'PATCH',
    path: `/api/agents/current?path=${encodeURIComponent(REPO_ROOT + '/apps')}`,
    body: { description: 'x' },
    expect: { status: 404, body: { error: 'No agent registered at this path' } },
  },
  {
    name: 'POST /api/agents/current/migrate-persona refuses a request with no path',
    method: 'POST',
    path: '/api/agents/current/migrate-persona',
    expect: { status: 400, body: { error: 'path query parameter required' } },
  },
  {
    name: 'POST /api/agents/current/migrate-persona answers 404 for a folder with no agent',
    method: 'POST',
    path: `/api/agents/current/migrate-persona?path=${encodeURIComponent(REPO_ROOT + '/apps')}`,
    expect: { status: 404, body: { error: 'No agent registered at this path' } },
  },
  {
    name: 'GET /api/agents is the /api 404',
    path: '/api/agents',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /api/agents/:id is the /api 404',
    path: `/api/agents/${UNKNOWN_ULID}`,
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /api/agents/resolve is the /api 404',
    path: '/api/agents/resolve',
    expect: { status: 404, body: NOT_FOUND },
  },

  // the groups beside agents under the same prefix
  {
    name: 'GET /api/agents/pauses still answers from the pause routes',
    path: '/api/agents/pauses',
    expect: { status: 200, schema: AgentPauseListSchema },
  },
  {
    name: 'GET /api/agents/mcp-oauth/callback sends a sign-in it never started to the landing page',
    path: '/api/agents/mcp-oauth/callback?state=nobody&code=nothing',
    expect: {
      status: 303,
      headers: {
        location: /\/signed-in\?landing=[A-Za-z0-9_-]+$/,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    },
  },
  {
    name: 'GET /api/agents/mcp-oauth/callback/ answers with a trailing slash',
    path: '/api/agents/mcp-oauth/callback/',
    expect: { status: 303, headers: { location: /\/signed-in\?landing=/ } },
  },
  // the sign-in landing page's record and Try again (`routes/sign-in-landings.ts`)
  {
    name: 'GET /api/sign-in-landings/:id answers a record it never wrote with 404',
    path: '/api/sign-in-landings/nobody',
    expect: {
      status: 404,
      body: { error: 'This sign-in page expired.', code: 'SIGNIN_LANDING_GONE' },
    },
  },
  {
    name: 'POST /api/sign-in-landings/:id/retry answers a record it never wrote with 404',
    method: 'POST',
    path: '/api/sign-in-landings/nobody/retry',
    body: {},
    expect: {
      status: 404,
      body: { error: 'This sign-in page expired.', code: 'SIGNIN_LANDING_GONE' },
    },
  },
  {
    name: 'GET /api/sign-in-landings/:id refuses a foreign Host',
    path: '/api/sign-in-landings/nobody',
    headers: { host: 'evil.example.com' },
    expect: { status: 403 },
  },
  {
    name: 'POST /api/agents/mcp-oauth/callback is the /api 404',
    method: 'POST',
    path: '/api/agents/mcp-oauth/callback',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'POST /api/agents/:id/commitments refuses an agent',
    method: 'POST',
    path: `/api/agents/${UNKNOWN_ULID}/commitments`,
    headers: AGENT,
    body: {},
    expect: {
      status: 403,
      body: {
        error: 'Agents record their own promises with commitment_add.',
        code: 'NOT_A_PERSON',
      },
    },
  },
  {
    name: 'POST /api/agents/:id/commitments refuses an empty body',
    method: 'POST',
    path: `/api/agents/${UNKNOWN_ULID}/commitments`,
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /api/agents/:id/work-queue refuses an agent',
    path: `/api/agents/${UNKNOWN_ULID}/work-queue`,
    headers: AGENT,
    expect: {
      status: 403,
      body: { error: 'Agents use their own work queue tools.', code: 'NOT_A_PERSON' },
    },
  },
  {
    name: 'PATCH /api/agents/:id/work-queue refuses an agent turning a queue on',
    method: 'PATCH',
    path: `/api/agents/${UNKNOWN_ULID}/work-queue`,
    headers: AGENT,
    body: { enabled: true },
    expect: {
      status: 403,
      body: { error: 'Agents use their own work queue tools.', code: 'NOT_A_PERSON' },
    },
  },
  {
    name: 'GET /api/agents/:id/work-queue answers 404 for an unknown agent',
    path: `/api/agents/${UNKNOWN_ULID}/work-queue`,
    expect: {
      status: 404,
      body: { error: 'No agent on the team has that id.', code: 'NOT_FOUND' },
    },
  },
  {
    name: 'PUT /api/work-queues/stop refuses an agent',
    method: 'PUT',
    path: '/api/work-queues/stop',
    headers: AGENT,
    body: { stopped: false },
    expect: {
      status: 403,
      body: { error: 'Only the owner can stop every queue.', code: 'NOT_YOURS' },
    },
  },
  {
    name: 'GET /api/agents/:id/commitments is the /api 404',
    path: `/api/agents/${UNKNOWN_ULID}/commitments`,
    expect: { status: 404, body: NOT_FOUND },
  },

  {
    name: 'GET /api/commitments lists no promises',
    path: '/api/commitments',
    expect: { status: 200, headers: JSON_TYPE, body: { commitments: [] } },
  },
  {
    name: 'GET /api/commitments/ answers with a trailing slash and a filter',
    path: '/api/commitments/?state=open&limit=5',
    expect: { status: 200, schema: ListCommitmentsResponseSchema },
  },
  {
    name: 'HEAD /api/commitments answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/commitments',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/commitments refuses a limit out of range',
    path: '/api/commitments?limit=0',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/commitments/:id refuses a body with no state',
    method: 'PATCH',
    path: '/api/commitments/no-such-promise',
    body: { note: 'x' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'PATCH /api/commitments/:id refuses an agent that could not be identified',
    method: 'PATCH',
    path: '/api/commitments/no-such-promise',
    headers: AGENT,
    body: { state: 'kept' },
    expect: {
      status: 403,
      body: { error: 'This agent could not be identified, so nothing changed.', code: 'NO_AGENT' },
    },
  },
  {
    name: 'PATCH /api/commitments/:id answers 404 for an unknown promise',
    method: 'PATCH',
    path: '/api/commitments/no-such-promise',
    body: { state: 'kept' },
    expect: { status: 404, schema: z.object({ code: z.literal('NOT_FOUND') }).loose() },
  },
  {
    name: 'GET /api/commitments/:id is the /api 404',
    path: '/api/commitments/no-such-promise',
    expect: { status: 404, body: NOT_FOUND },
  },

  // discovery
  {
    name: 'POST /api/discovery/scan refuses a depth out of range',
    method: 'POST',
    path: '/api/discovery/scan',
    body: { root: REPO_ROOT, maxDepth: 0 },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/discovery/scan refuses a root outside the boundary, before streaming',
    method: 'POST',
    path: '/api/discovery/scan',
    body: { roots: [REPO_ROOT, '/'] },
    expect: {
      status: 403,
      headers: JSON_TYPE,
      body: { error: 'Root path outside directory boundary' },
    },
  },
  {
    name: 'GET /api/discovery/scan is the /api 404',
    path: '/api/discovery/scan',
    expect: { status: 404, body: NOT_FOUND },
  },

  // the chain in front of every group
  {
    name: 'GET /api/mesh/agents refuses a foreign Host',
    path: '/api/mesh/agents',
    headers: { host: 'evil.example.com' },
    expect: { status: 403, schema: z.object({ error: z.string() }).loose() },
  },
  {
    name: 'GET /api/mesh/status answers a same-origin browser with its CORS headers',
    path: '/api/mesh/status',
    headers: { origin: SERVER_ORIGIN },
    expect: {
      status: 200,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
        vary: /Origin/,
      },
    },
  },
]);

/** A request against a hand-driven server, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/** Send one case to the server this file booted itself. */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/**
 * Send one setup request and return its JSON body, failing loudly when the
 * server refuses it.
 */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** A fresh folder under {@link WORK}. */
function freshDir(name: string): string {
  const dir = path.join(WORK, `${name}-${randomUUID().slice(0, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MANIFEST = AgentManifestSchema.loose();

describe('contract: mesh, agents and discovery, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  beforeAll(async () => {
    server = await bootComposedServer();
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('creates an agent, reads it from both groups, changes it, and removes it', async () => {
    const dir = freshDir('created');
    await check(server, {
      method: 'POST',
      path: '/api/agents',
      body: { path: dir, name: 'Contract Agent', description: 'made by the contract' },
      expect: {
        status: 201,
        headers: JSON_TYPE,
        schema: MANIFEST.extend({
          name: z.literal('contract-agent'),
          displayName: z.literal('Contract Agent'),
          description: z.literal('made by the contract'),
          isSystem: z.literal(false),
        }),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/agents',
      body: { path: dir, name: 'again' },
      expect: {
        status: 409,
        schema: z
          .object({ error: z.literal('Agent already exists at this path'), agent: MANIFEST })
          .strict(),
      },
    });
    const current = await setup(
      server,
      'GET',
      `/api/agents/current?path=${encodeURIComponent(dir)}`
    );
    const id = current.id as string;
    await check(server, {
      path: `/api/agents/current?path=${encodeURIComponent(dir)}`,
      expect: {
        status: 200,
        schema: MANIFEST.extend({
          id: z.literal(id),
          soulContent: z.string().includes('Contract Agent'),
          nopeContent: z.string(),
          memoryContent: z.string(),
          heartbeatContent: z.string().nullable(),
        }),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/agents/resolve',
      body: { paths: [dir] },
      expect: {
        status: 200,
        schema: z.object({ agents: z.object({ [dir]: MANIFEST.extend({ id: z.literal(id) }) }) }),
      },
    });
    await check(server, {
      path: `/api/mesh/agents/${id}`,
      expect: { status: 200, schema: MANIFEST.extend({ id: z.literal(id) }) },
    });
    await check(server, {
      path: `/api/mesh/agents/${id}/health`,
      expect: { status: 200, schema: z.object({ agentId: z.literal(id) }).loose() },
    });
    await check(server, {
      path: `/api/mesh/agents/${id}/access`,
      expect: { status: 200, schema: AGENT_LIST },
    });
    await check(server, {
      path: '/api/mesh/agents',
      expect: {
        status: 200,
        schema: AGENT_LIST.refine((list) => list.agents.some((agent) => agent.id === id)),
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/mesh/agents/${id}/heartbeat`,
      body: { event: 'contract' },
      expect: { status: 200, body: { success: true } },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/mesh/agents/${id}`,
      body: { description: 'changed through the mesh' },
      expect: {
        status: 200,
        schema: MANIFEST.extend({ description: z.literal('changed through the mesh') }),
      },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/agents/current?path=${encodeURIComponent(dir)}`,
      body: { description: 'changed by path' },
      expect: {
        status: 200,
        schema: MANIFEST.extend({ description: z.literal('changed by path') }),
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/agents/current/migrate-persona?path=${encodeURIComponent(dir)}`,
      expect: { status: 200, body: { migrated: false, reason: 'SOUL.md already exists' } },
    });

    // A real agent token is a machine, and only a person may do these.
    const minted = await setup(server, 'POST', '/api/test/agent-token', { agentPath: dir });
    const asAgent = { 'X-DorkOS-Agent': minted.token as string };
    await check(server, {
      method: 'PATCH',
      path: `/api/mesh/agents/${id}`,
      headers: asAgent,
      body: { effort: 'high' },
      expect: { status: 403, schema: NEEDS_APPROVAL },
    });
    await check(server, {
      method: 'POST',
      path: `/api/agents/${id}/commitments`,
      headers: asAgent,
      body: { text: 'a promise' },
      expect: { status: 403, schema: z.object({ code: z.literal('NOT_A_PERSON') }).loose() },
    });
    await check(server, {
      method: 'POST',
      path: '/api/agents/create',
      headers: asAgent,
      body: { package: { name: 'some-agent' } },
      expect: { status: 403, schema: z.object({ code: z.literal('operator_only') }).loose() },
    });

    // A person adds a promise for the agent, anyone lists it, and a person closes it.
    const promise = await setup(server, 'POST', `/api/agents/${id}/commitments`, {
      what: 'Reply to the contract',
      to: 'external:Contract',
    });
    await check(server, {
      method: 'POST',
      path: `/api/agents/${id}/commitments/`,
      body: { what: 'A second promise' },
      expect: {
        status: 201,
        schema: CommitmentSchema.extend({ agentId: z.literal(id), state: z.literal('open') }),
      },
    });
    await check(server, {
      path: `/api/commitments?agentId=${id}`,
      headers: asAgent,
      expect: {
        status: 200,
        schema: z.object({ commitments: z.array(CommitmentSchema).length(2) }),
      },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/commitments/${promise.id as string}`,
      body: { state: 'kept', note: 'replied' },
      expect: {
        status: 200,
        schema: CommitmentSchema.extend({ state: z.literal('kept'), note: z.literal('replied') }),
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/agents/${UNKNOWN_ULID}/commitments`,
      body: { what: 'For nobody' },
      expect: {
        status: 404,
        body: { error: 'No agent on the team has that id.', code: 'UNKNOWN_AGENT' },
      },
    });

    await check(server, {
      method: 'DELETE',
      path: `/api/mesh/agents/${id}`,
      expect: { status: 200, body: { success: true, blockedFromDiscovery: false } },
    });
    await check(server, {
      path: `/api/mesh/agents/${id}`,
      expect: { status: 404, body: AGENT_NOT_FOUND },
    });
  });

  it('registers a folder through the mesh and removes it with its data', async () => {
    const dir = freshDir('registered');
    const registered = await setup(server, 'POST', '/api/mesh/agents', {
      path: dir,
      overrides: { name: 'registered-agent', runtime: 'claude-code' },
    });
    expect(registered.name).toBe('registered-agent');
    await check(server, {
      method: 'POST',
      path: '/api/mesh/agents',
      body: { path: dir },
      expect: {
        status: 201,
        schema: MANIFEST.extend({ id: z.literal(registered.id as string) }),
      },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/mesh/agents/${registered.id as string}/data`,
      expect: {
        status: 200,
        body: { success: true, deletedPath: path.join(dir, '.dork') },
      },
    });
  });

  it('protects the system agent from renaming, removal and deletion', async () => {
    const { agents } = (await setup(server, 'GET', '/api/mesh/agents')) as {
      agents: Array<{ id: string; isSystem?: boolean }>;
    };
    const system = agents.find((agent) => agent.isSystem);
    expect(system).toBeDefined();
    await check(server, {
      method: 'PATCH',
      path: `/api/mesh/agents/${system!.id}`,
      body: { name: 'renamed', description: 'changed' },
      expect: { status: 403, body: { error: 'Cannot modify name, description on system agents' } },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/mesh/agents/${system!.id}`,
      expect: { status: 403, body: { error: 'System agents cannot be removed' } },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/mesh/agents/${system!.id}/data`,
      expect: { status: 403, body: { error: 'System agents cannot be deleted' } },
    });
    await check(server, {
      path: `/api/mesh/agents/${system!.id}`,
      expect: { status: 200, schema: MANIFEST.extend({ isSystem: z.literal(true) }) },
    });
  });

  it('denies a folder and clears it through its encoded path', async () => {
    const dir = freshDir('denied');
    await check(server, {
      method: 'POST',
      path: '/api/mesh/deny',
      body: { path: dir, reason: 'contract' },
      expect: { status: 201, body: { success: true } },
    });
    await check(server, {
      path: '/api/mesh/denied',
      expect: {
        status: 200,
        schema: z.object({
          denied: z
            .array(z.object({ path: z.string() }).loose())
            .refine((rows) => rows.some((row) => row.path === dir)),
        }),
      },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/mesh/denied/${encodeURIComponent(dir)}`,
      expect: { status: 200, body: { success: true } },
    });
    await check(server, {
      path: '/api/mesh/denied',
      expect: { status: 200, body: { denied: [] } },
    });
  });

  it('opens and closes a cross-namespace rule', async () => {
    await check(server, {
      method: 'PUT',
      path: '/api/mesh/topology/access',
      body: { sourceNamespace: 'alpha', targetNamespace: 'beta', action: 'allow' },
      expect: {
        status: 200,
        body: {
          sourceNamespace: 'alpha',
          targetNamespace: 'beta',
          action: 'allow',
          origin: 'explicit',
        },
      },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/mesh/topology/access',
      body: { sourceNamespace: 'alpha', targetNamespace: 'beta', action: 'deny' },
      expect: {
        status: 200,
        body: {
          sourceNamespace: 'alpha',
          targetNamespace: 'beta',
          action: 'deny',
          origin: 'explicit',
        },
      },
    });
  });

  it('lists candidates through the mesh and streams a scan through discovery', async () => {
    const root = freshDir('scan');
    const project = path.join(root, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'CLAUDE.md'), '# A project an agent works in\n');
    await check(server, {
      method: 'POST',
      path: '/api/mesh/discover',
      body: { roots: [root], maxDepth: 2 },
      expect: {
        status: 200,
        schema: z
          .object({
            candidates: z
              .array(z.object({ path: z.string() }).loose())
              .refine((found) => found.some((candidate) => candidate.path === project)),
            truncated: z.literal(false),
          })
          .strict(),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/discovery/scan',
      headers: { origin: SERVER_ORIGIN },
      body: { root, maxDepth: 2, timeout: 10_000 },
      expect: {
        status: 200,
        headers: {
          ...EVENT_STREAM,
          'access-control-allow-origin': SERVER_ORIGIN,
          'access-control-allow-credentials': 'true',
          'x-content-type-options': 'nosniff',
          'content-length': null,
        },
        schema: z
          .string()
          .startsWith('event: ')
          .includes(`event: candidate\ndata: {"path":${JSON.stringify(project)}`)
          .refine((text) => /event: complete\ndata: \{.*"timedOut":false.*\}\n\n$/.test(text)),
      },
    });
    // A trailing slash reaches the same stream; only its headers are pinned.
    await check(server, {
      method: 'POST',
      path: '/api/discovery/scan/',
      body: { roots: [root], maxDepth: 1, timeout: 10_000 },
      expect: { status: 200, headers: EVENT_STREAM },
    });
  });
});
