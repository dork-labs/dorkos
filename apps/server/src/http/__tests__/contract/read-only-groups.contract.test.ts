/**
 * Contract for the small read-only and system route groups that move to Hono
 * together in DOR-2797: models, commands, subagents, the three capabilities
 * routers, system, errors, keep-awake, team, activity, audit, search, and the
 * API docs. Health has its own file. That PR must pass this file unchanged.
 *
 * The composed server runs the test-mode runtime with a fresh data directory,
 * so lists are mostly empty and the answers below are what such a server
 * gives. Shapes are checked against the shared response schemas where there is
 * one; values that change per boot (ids, timestamps, a port) are not pinned.
 * The chain every route sits behind (host guard, CORS, session gate, the `/api`
 * 404) is held to Express by the chain-parity matrix, so only a group's own
 * answers and refusals are here.
 */
import { expect } from 'vitest';
import { z } from 'zod';
import {
  CommandRegistrySchema,
  KeepAwakeStatusSchema,
  ModelOptionSchema,
  SubagentInfoSchema,
} from '@dorkos/shared/schemas';
import { ListActivityResponseSchema } from '@dorkos/shared/activity-schemas';
import { AuditEventSchema, AuditVerifyResultSchema } from '@dorkos/shared/audit-schemas';
import { SearchResponseSchema } from '@dorkos/shared/search-schemas';
import { TeamRosterResponseSchema } from '@dorkos/shared/team-schemas';
import { contractSuite } from './harness.js';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** A page of the capability catalog. */
const CATALOG_PAGE = z
  .object({ catalogVersion: z.string(), total: z.number().int().positive() })
  .loose();
/** Input `mcp.add` accepts, so a call reaches its tier gate rather than validation. */
const MCP_ADD_INPUT = {
  agentId: 'no-such-agent',
  name: 'contract-probe',
  connection: { transport: 'stdio', command: 'true' },
};

contractSuite('read-only and system groups', [
  // models
  {
    name: 'GET /api/models lists the default runtime’s models',
    path: '/api/models',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({ models: z.array(ModelOptionSchema) }),
    },
  },
  {
    name: 'GET /api/models refuses an unknown runtime',
    path: '/api/models?runtime=nope',
    expect: { status: 400, body: { error: 'Unknown runtime: nope' } },
  },

  // commands
  {
    name: 'GET /api/commands answers the command registry',
    path: '/api/commands',
    expect: { status: 200, headers: JSON_TYPE, schema: CommandRegistrySchema },
  },
  {
    name: 'GET /api/commands refuses a malformed query',
    path: '/api/commands?refresh=maybe',
    expect: {
      status: 400,
      body: {
        error: 'Invalid query',
        details: {
          errors: [],
          properties: { refresh: { errors: ['Invalid option: expected one of "true"|"false"'] } },
        },
      },
    },
  },
  {
    name: 'GET /api/commands refuses an unknown runtime',
    path: '/api/commands?runtime=nope',
    expect: { status: 400, body: { error: 'Unknown runtime: nope' } },
  },
  {
    name: 'GET /api/commands refuses a directory outside the boundary',
    path: '/api/commands?cwd=/etc',
    expect: {
      status: 403,
      body: { error: 'Access denied: path outside directory boundary', code: 'OUTSIDE_BOUNDARY' },
    },
  },

  // subagents
  {
    name: 'GET /api/subagents lists the default runtime’s subagents',
    path: '/api/subagents',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({ subagents: z.array(SubagentInfoSchema) }),
    },
  },

  // capabilities: the runtime matrix, the catalog, and invoke
  {
    name: 'GET /api/capabilities answers each runtime’s capabilities and the default',
    path: '/api/capabilities',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({
        capabilities: z.record(z.string(), z.object({ type: z.string() }).loose()),
        defaultRuntime: z.literal('test-mode'),
      }),
    },
  },
  {
    name: 'GET /api/capabilities/catalog pages the catalog',
    path: '/api/capabilities/catalog?limit=2',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z
        .object({
          catalogVersion: z.string(),
          total: z.number().int().positive(),
          returned: z.literal(2),
          offset: z.literal(0),
          nextCursor: z.string(),
        })
        .loose(),
    },
  },
  {
    name: 'GET /api/capabilities/catalog refuses a limit below one',
    path: '/api/capabilities/catalog?limit=0',
    expect: {
      status: 400,
      body: {
        error: 'Validation failed',
        details: {
          formErrors: [],
          fieldErrors: { limit: ['Too small: expected number to be >=1'] },
        },
      },
    },
  },
  {
    name: 'GET /api/capabilities/catalog refuses a cursor it never issued',
    path: '/api/capabilities/catalog?cursor=zzz',
    expect: {
      status: 400,
      body: { error: 'Invalid cursor "zzz"; use the nextCursor from a previous response.' },
    },
  },
  {
    name: 'POST /api/capabilities/:id/invoke refuses an unknown capability',
    method: 'POST',
    path: '/api/capabilities/nope.nope/invoke',
    body: {},
    expect: {
      status: 404,
      body: { error: 'Unknown capability: nope.nope', code: 'UNKNOWN_CAPABILITY' },
    },
  },

  // system
  {
    name: 'GET /api/system/requirements answers each runtime’s readiness',
    path: '/api/system/requirements',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: {
        runtimes: {
          'test-mode': {
            dependencies: [
              {
                name: 'Test Mode Runtime',
                description: 'No external dependencies required.',
                status: 'satisfied',
              },
            ],
            state: 'ready',
          },
        },
      },
    },
  },
  {
    name: 'GET /api/system/unattended-autonomy answers with no drivers on a fresh install',
    path: '/api/system/unattended-autonomy',
    expect: { status: 200, headers: JSON_TYPE, body: { drivers: [] } },
  },
  {
    name: 'GET /api/system/memory answers the memory provider’s state',
    path: '/api/system/memory',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      body: { configuredId: 'builtin', activeId: 'builtin', benched: false, benchReason: null },
    },
  },
  {
    name: 'an unknown /api/system path is the API 404',
    path: '/api/system/nope',
    expect: { status: 404, body: NOT_FOUND },
  },

  // errors
  {
    name: 'POST /api/errors accepts a client error report',
    method: 'POST',
    path: '/api/errors',
    body: { name: 'TypeError', message: 'x is undefined' },
    expect: { status: 202, headers: JSON_TYPE, body: { ok: true } },
  },
  {
    name: 'POST /api/errors accepts a malformed report and drops it',
    method: 'POST',
    path: '/api/errors',
    body: { message: 5 },
    expect: { status: 202, body: { ok: true } },
  },
  {
    name: 'POST /api/errors accepts an empty body',
    method: 'POST',
    path: '/api/errors',
    expect: { status: 202, body: { ok: true } },
  },
  {
    name: 'GET /api/errors is not a route',
    path: '/api/errors',
    expect: { status: 404, body: NOT_FOUND },
  },

  // keep-awake
  {
    name: 'GET /api/keep-awake answers the keep-awake status',
    path: '/api/keep-awake',
    expect: { status: 200, headers: JSON_TYPE, schema: KeepAwakeStatusSchema },
  },

  // team
  {
    name: 'GET /api/team answers the roster',
    path: '/api/team',
    expect: { status: 200, headers: JSON_TYPE, schema: TeamRosterResponseSchema },
  },
  {
    name: 'GET /api/team/:memberId/rooms refuses an unknown member',
    path: '/api/team/nobody/rooms',
    expect: { status: 404, body: { error: 'No member with that id', code: 'MEMBER_NOT_FOUND' } },
  },

  // activity
  {
    name: 'GET /api/activity answers the feed',
    path: '/api/activity',
    expect: { status: 200, headers: JSON_TYPE, schema: ListActivityResponseSchema },
  },
  {
    name: 'GET /api/activity refuses a malformed limit',
    path: '/api/activity?limit=abc',
    expect: {
      status: 400,
      body: {
        error: 'Validation failed',
        details: {
          formErrors: [],
          fieldErrors: { limit: ['Invalid input: expected number, received NaN'] },
        },
      },
    },
  },

  // audit
  {
    name: 'GET /api/audit answers the record',
    path: '/api/audit',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({ events: z.array(AuditEventSchema) }),
    },
  },
  {
    name: 'GET /api/audit refuses a malformed limit',
    path: '/api/audit?limit=abc',
    expect: {
      status: 400,
      body: {
        error: 'Validation failed',
        details: {
          formErrors: [],
          fieldErrors: { limit: ['Invalid input: expected number, received NaN'] },
        },
      },
    },
  },
  {
    name: 'GET /api/audit/verify checks the chain',
    path: '/api/audit/verify',
    expect: { status: 200, headers: JSON_TYPE, schema: AuditVerifyResultSchema },
  },
  {
    name: 'GET /api/audit/:id refuses an id it has no event for',
    path: '/api/audit/nope',
    expect: { status: 404, body: { error: 'No audit event with that id.', code: 'NOT_FOUND' } },
  },
  {
    name: 'GET /api/audit/accounts/:accountId/timeline answers an empty timeline',
    path: '/api/audit/accounts/x/timeline',
    expect: { status: 200, headers: JSON_TYPE, body: { events: [] } },
  },

  // search
  {
    name: 'GET /api/search answers a search',
    path: '/api/search?q=hello',
    expect: { status: 200, headers: JSON_TYPE, schema: SearchResponseSchema },
  },
  {
    name: 'GET /api/search refuses a search with no word to look for',
    path: '/api/search',
    expect: {
      status: 400,
      body: {
        error: 'Search needs a word of at least 2 letters to look for.',
        code: 'INVALID_SEARCH_QUERY',
      },
    },
  },
  {
    name: 'GET /api/search refuses an empty word',
    path: '/api/search?q=',
    expect: {
      status: 400,
      body: {
        error: 'Search needs a word of at least 2 letters to look for.',
        code: 'INVALID_SEARCH_QUERY',
      },
    },
  },

  // An agent that presents a token this machine never minted
  {
    name: 'GET /api/search refuses an agent token it cannot resolve',
    path: '/api/search?q=hello',
    headers: { 'x-dorkos-agent': 'not-a-real-token' },
    expect: {
      status: 401,
      body: {
        error:
          'That agent identity could not be verified. Its token may have been revoked, or it may have expired.',
        code: 'AGENT_IDENTITY_UNVERIFIED',
      },
    },
  },
  {
    name: 'GET /api/audit reads as an unknown agent',
    path: '/api/audit',
    headers: { 'x-dorkos-agent': 'not-a-real-token' },
    expect: { status: 200, schema: z.object({ events: z.array(AuditEventSchema) }) },
  },
  {
    name: 'GET /api/team/:memberId/rooms refuses an agent',
    path: '/api/team/nobody/rooms',
    headers: { 'x-dorkos-agent': 'not-a-real-token' },
    expect: { status: 403, body: { error: 'Only people read a profile', code: 'PEOPLE_ONLY' } },
  },
  {
    name: 'POST /api/capabilities/:id/invoke runs a read capability for an unknown agent',
    method: 'POST',
    path: '/api/capabilities/capabilities.list/invoke',
    headers: { 'x-dorkos-agent': 'not-a-real-token' },
    body: {},
    expect: {
      status: 200,
      schema: z.object({ catalogVersion: z.string(), total: z.number().int().positive() }).loose(),
    },
  },
  {
    name: 'POST /api/capabilities/:id/invoke runs a read capability',
    method: 'POST',
    path: '/api/capabilities/capabilities.list/invoke',
    body: {},
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({ catalogVersion: z.string(), total: z.number().int().positive() }).loose(),
    },
  },
  {
    name: 'POST /api/capabilities/:id/invoke refuses input its schema rejects',
    method: 'POST',
    path: '/api/capabilities/capabilities.list/invoke',
    body: { limit: 0 },
    expect: {
      status: 400,
      body: {
        error: 'Validation failed',
        details: {
          formErrors: [],
          fieldErrors: { limit: ['Too small: expected number to be >=1'] },
        },
      },
    },
  },

  // Express parses a repeated query key into an array, which these routes
  // read as absent; a move must keep that, not take the last value.
  {
    name: 'GET /api/models reads a repeated runtime as none',
    path: '/api/models?runtime=test-mode&runtime=nope',
    expect: { status: 200, body: { models: [] } },
  },
  {
    name: 'GET /api/commands reads a repeated runtime as none',
    path: '/api/commands?runtime=test-mode&runtime=nope',
    expect: { status: 400, body: expect.objectContaining({ error: 'Invalid query' }) },
  },
  {
    name: 'GET /api/subagents reads a repeated session as none',
    path: '/api/subagents?sessionId=a&sessionId=b',
    expect: { status: 200, body: { subagents: [] } },
  },
  {
    name: 'GET /api/search reads a repeated word',
    path: '/api/search?q=hello&q=world',
    expect: {
      status: 400,
      body: {
        error: 'Search needs a word of at least 2 letters to look for.',
        code: 'INVALID_SEARCH_QUERY',
      },
    },
  },
  // Bodies
  {
    name: 'POST /api/capabilities/:id/invoke with no body at all',
    method: 'POST',
    path: '/api/capabilities/capabilities.list/invoke',
    expect: { status: 200, schema: CATALOG_PAGE },
  },
  {
    name: 'POST /api/capabilities/:id/invoke with malformed JSON',
    method: 'POST',
    path: '/api/capabilities/capabilities.list/invoke',
    headers: { 'content-type': 'application/json' },
    body: '{"limit":',
    expect: {
      status: 500,
      body: { error: 'Unexpected end of JSON input', code: 'INTERNAL_ERROR' },
    },
  },
  {
    name: 'POST /api/capabilities/:id/invoke with a body that is not JSON',
    method: 'POST',
    path: '/api/capabilities/capabilities.list/invoke',
    headers: { 'content-type': 'text/plain' },
    body: 'limit=2',
    expect: { status: 200, schema: CATALOG_PAGE },
  },
  {
    name: 'POST /api/errors with malformed JSON',
    method: 'POST',
    path: '/api/errors',
    headers: { 'content-type': 'application/json' },
    body: '{"message":',
    expect: {
      status: 500,
      body: { error: 'Unexpected end of JSON input', code: 'INTERNAL_ERROR' },
    },
  },
  // The tier gate on invoke
  {
    name: 'POST /api/capabilities/:id/invoke gates a destructive call by an agent',
    method: 'POST',
    path: '/api/capabilities/mcp.add/invoke',
    headers: { 'x-dorkos-agent': 'not-a-real-token' },
    body: MCP_ADD_INPUT,
    expect: {
      status: 202,
      body: expect.objectContaining({
        status: 'approval_required',
        capabilityId: 'mcp.add',
        tier: 'destructive',
        reason: 'no_approval',
      }),
    },
  },
  {
    // A forged token is not honoured: the call is gated afresh.
    name: 'POST /api/capabilities/:id/invoke does not honour an approval token it never issued',
    method: 'POST',
    path: '/api/capabilities/mcp.add/invoke',
    headers: { 'x-dorkos-agent': 'not-a-real-token', 'x-dorkos-approval': 'forged' },
    body: MCP_ADD_INPUT,
    expect: {
      status: 202,
      body: expect.objectContaining({
        status: 'approval_required',
        capabilityId: 'mcp.add',
        reason: 'unknown_token',
      }),
    },
  },
  // HEAD
  {
    name: 'HEAD /api/models answers like GET, with no body',
    method: 'HEAD',
    path: '/api/models',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'HEAD /api/docs answers like GET, with no body',
    method: 'HEAD',
    path: '/api/docs',
    expect: { status: 200, headers: { 'content-type': /^text\/html\b/ }, body: '' },
  },

  // the API docs
  {
    name: 'GET /api/openapi.json answers the OpenAPI document',
    path: '/api/openapi.json',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z
        .object({
          openapi: z.literal('3.1.0'),
          info: z.object({ title: z.literal('DorkOS API') }).loose(),
          paths: z.record(z.string(), z.unknown()),
        })
        .loose(),
    },
  },
  {
    name: 'GET /api/docs serves the interactive reference',
    path: '/api/docs',
    expect: {
      status: 200,
      headers: { 'content-type': /^text\/html\b/ },
      body: expectContains('Scalar API Reference'),
    },
  },
]);

/** A body check for an HTML page: the text includes `needle`. */
function expectContains(needle: string): unknown {
  return expect.stringContaining(needle);
}
