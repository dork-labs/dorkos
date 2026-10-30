/**
 * OpenAPI for the person's Claude sign-in list (`routes/account-signin.ts`)
 * and the vendor login route (DOR-3245).
 *
 * @module services/health/account-signin-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

const empty = z.object({}).strict();
const identity = z.object({
  state: z.enum([
    'unreadable',
    'unconfirmed',
    'changed',
    'blocked',
    'confirmed',
    'grandfathered',
    'never-use',
  ]),
  email: z.string().optional(),
  previousEmail: z.string().optional(),
  orgChanged: z.boolean().optional(),
});
const folder = z.object({ accountId: z.string(), path: z.string(), label: z.string() });
const organization = z.object({ id: z.uuid(), label: z.string() });
const account = z.object({ accountId: z.string(), path: z.string(), name: z.string(), identity });
const error = { description: 'The request is refused' };
const owner =
  'The person only: agents, API keys and teammates are refused, and with login on it needs the owner’s browser session. No secret, account id or unmasked email is returned.';

/** The owner-only account identity and exclusion policy, separate from agent tools. */
export function registerAccountSigninOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/runtimes/claude-code/signins',
    tags: ['Runtimes'],
    summary: 'Read Claude sign-in identity and exclusions',
    description: owner,
    responses: {
      200: {
        description: 'Owner policy and masked account identities',
        content: {
          'application/json': {
            schema: z.object({
              deniedOrganizations: z.array(organization),
              folders: z.array(folder),
              accounts: z.array(account),
            }),
          },
        },
      },
      403: error,
      503: error,
    },
  });
  const mutations = [
    {
      method: 'post' as const,
      suffix: '/organizations',
      summary: 'Exclude an organization',
      body: z.object({ orgId: z.uuid(), label: z.string().trim().min(1).max(80) }).strict(),
    },
    {
      method: 'delete' as const,
      suffix: '/organizations/{id}',
      summary: 'Remove an organization exclusion',
      body: empty,
    },
    {
      method: 'post' as const,
      suffix: '/folders',
      summary: 'Exclude a registered folder',
      body: z.object({ accountId: z.string().min(1) }).strict(),
    },
    {
      method: 'delete' as const,
      suffix: '/folders/{id}',
      summary: 'Remove a folder exclusion',
      body: empty,
    },
    {
      method: 'post' as const,
      suffix: '/{id}/accept',
      summary: 'Confirm a folder’s current identity',
      body: empty,
    },
  ];
  for (const mutation of mutations)
    registry.registerPath({
      method: mutation.method,
      path: '/api/runtimes/claude-code/signins' + mutation.suffix,
      tags: ['Runtimes'],
      summary: mutation.summary,
      description:
        owner +
        ' Folder targets resolve by registry ID on the server. A sign-in in an excluded organization can never be accepted. A folder exclusion stops every account read and launch there.',
      request: {
        ...(mutation.suffix.includes('{id}')
          ? {
              params: z.object({
                id: mutation.suffix.startsWith('/organizations') ? z.uuid() : z.string(),
              }),
            }
          : {}),
        body: { content: { 'application/json': { schema: mutation.body } } },
      },
      responses: {
        200: {
          description: 'Policy saved',
          content: {
            'application/json': {
              schema: z.object({ ok: z.literal(true), identity: identity.optional() }),
            },
          },
        },
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    });
  registry.registerPath({
    method: 'post',
    path: '/api/runtimes/{type}/login',
    tags: ['Runtimes'],
    summary: 'Start a vendor sign-in',
    description:
      'The owner at this computer only: the vendor sign-in opens a browser here. Claude takes a registered accountId or a sessionId bound to a registered account; paths and unknown accounts are refused, and the default is never substituted. A Claude sign-in completed here is confirmed in the same step and returned as a masked identity. Codex accepts no accountId.',
    request: {
      params: z.object({ type: z.enum(['claude-code', 'codex']) }),
      body: {
        content: {
          'application/json': {
            schema: z
              .object({ accountId: z.string().optional(), sessionId: z.string().optional() })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Login result',
        content: {
          'application/json': {
            schema: z.object({
              ok: z.boolean(),
              error: z.string().optional(),
              identity: identity.optional(),
            }),
          },
        },
      },
      400: error,
      403: error,
    },
  });
}
