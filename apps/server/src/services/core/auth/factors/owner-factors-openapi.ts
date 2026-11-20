/**
 * OpenAPI entries for the owner's sign-in checks (DOR-3647, `routes/owner-factors.ts`),
 * and for signing in with a passkey (`http/sign-in/owner-passkey-sign-in.ts`).
 *
 * @module services/core/auth/factors/owner-factors-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

const TAGS = ['Auth'];

const ErrorSchema = z.object({ error: z.string(), code: z.string().optional() });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const OWNER_ONLY = json(
  ErrorSchema,
  'Not the owner, in the app, at the computer DorkOS runs on or signed in over https'
);

const FactorSchema = z.object({
  id: z.string(),
  kind: z.enum(['totp', 'passkey']),
  label: z.string(),
  host: z.string().optional(),
  addedAt: z.string(),
  lastUsedAt: z.string().optional(),
});

const LabelBody = {
  content: { 'application/json': { schema: z.object({ label: z.string().optional() }) } },
};

/**
 * Register the routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerOwnerFactorsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/owner-factors',
    tags: TAGS,
    summary: 'Your sign-in checks',
    description:
      'The passkeys and authenticator apps that prove a sign-in from another device. ' +
      'Never a secret or a key.',
    responses: {
      200: json(z.object({ factors: z.array(FactorSchema) }), 'The sign-in checks'),
      403: OWNER_ONLY,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/owner-factors/passkeys/options',
    tags: TAGS,
    summary: 'Start adding a passkey',
    description:
      'After "Confirm it’s you", a challenge to make a passkey on the address the browser is ' +
      'on. The person is always verified. Never over Wi-Fi.',
    request: { body: LabelBody },
    responses: {
      200: json(z.object({ options: z.unknown() }), 'The options to hand the browser'),
      403: OWNER_ONLY,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/owner-factors/passkeys/finish',
    tags: TAGS,
    summary: 'Finish adding a passkey',
    description:
      'Stores the new passkey, writes an Activity line and raises a notice. Each challenge ' +
      'works once.',
    request: {
      body: { content: { 'application/json': { schema: z.object({ response: z.unknown() }) } } },
    },
    responses: {
      200: json(z.object({ id: z.string(), host: z.string() }), 'Added'),
      400: json(ErrorSchema, 'The passkey was not added'),
      403: OWNER_ONLY,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/owner-factors/authenticator/start',
    tags: TAGS,
    summary: 'Start adding an authenticator app',
    description:
      'After "Confirm it’s you", a new secret and the address an authenticator app scans. ' +
      'It counts only once one of its codes is confirmed.',
    request: { body: LabelBody },
    responses: {
      200: json(
        z.object({ id: z.string(), secret: z.string(), uri: z.string() }),
        'The new secret to scan'
      ),
      403: OWNER_ONLY,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/owner-factors/authenticator/confirm',
    tags: TAGS,
    summary: 'Confirm an authenticator app',
    description: 'One good code from the app confirms it.',
    request: {
      body: {
        content: {
          'application/json': { schema: z.object({ id: z.string(), code: z.string() }) },
        },
      },
    },
    responses: {
      200: json(z.object({ id: z.string() }), 'Confirmed'),
      400: json(ErrorSchema, 'The code did not match'),
      403: OWNER_ONLY,
      404: json(ErrorSchema, 'Nothing waiting to confirm'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/owner-factors/{id}',
    tags: TAGS,
    summary: 'Remove a sign-in check',
    description: 'After "Confirm it’s you", removes one passkey or authenticator app.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Removed' },
      403: OWNER_ONLY,
      404: json(ErrorSchema, 'Already gone'),
    },
  });
}
