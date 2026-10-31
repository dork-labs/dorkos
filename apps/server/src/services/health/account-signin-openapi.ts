import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

const password = z
  .object({
    password: z.string().max(128).optional(),
    confirmOnThisComputer: z.literal(true).optional(),
  })
  .strict();
const identity = z.object({
  state: z.enum(['unreadable', 'unconfirmed', 'changed', 'blocked', 'confirmed', 'never-use']),
  email: z.string().optional(),
  previousEmail: z.string().optional(),
});
const folder = z.object({ accountId: z.string(), path: z.string(), label: z.string() });
const organization = z.object({ id: z.uuid(), label: z.string() });
const account = z.object({ accountId: z.string(), path: z.string(), name: z.string(), identity });
const error = { description: 'The request is refused' };
const owner =
  'Requires the owner’s signed-in cookie on any device. Agents, API keys and teammates are refused. Mutations require a fresh owner password check, or explicit confirmation at this computer when no owner password exists. No secret or unmasked email is returned.';

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
              stepUp: z.enum(['password', 'this-computer', 'other-computer']),
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
      body: password.extend({ orgId: z.uuid(), label: z.string().trim().min(1).max(80) }),
    },
    {
      method: 'delete' as const,
      suffix: '/organizations/{id}',
      summary: 'Remove an organization exclusion',
      body: password,
    },
    {
      method: 'post' as const,
      suffix: '/folders',
      summary: 'Exclude a registered folder',
      body: password.extend({ accountId: z.string().min(1) }),
    },
    {
      method: 'delete' as const,
      suffix: '/folders/{id}',
      summary: 'Remove a folder exclusion',
      body: password,
    },
    {
      method: 'post' as const,
      suffix: '/{id}/accept',
      summary: 'Confirm a folder’s current identity',
      body: password,
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
        ' Folder targets resolve by registry ID on the server. An excluded organization can never be accepted. Folder exclusions prevent all account reads and launches.',
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
        429: error,
        503: error,
      },
    });
  registry.registerPath({
    method: 'post',
    path: '/api/runtimes/{type}/login',
    tags: ['Runtimes'],
    summary: 'Start a vendor sign-in',
    description:
      'Claude requires an owner cookie and a registered accountId or a sessionId bound to a registered account. Paths and unknown accounts are refused; the default is never substituted. A completed login remains paused until its UUID identity is confirmed. Codex uses the existing person credential-change gate and accepts no accountId.',
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
