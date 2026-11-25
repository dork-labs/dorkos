/**
 * OpenAPI entries for the owner's sign-in checks (DOR-3647, `routes/owner-factors.ts`),
 * and for signing in with a passkey (`http/sign-in/owner-passkey-sign-in.ts`).
 *
 * @module services/core/auth/factors/owner-factors-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { problemResponse } from '../../openapi/problem-openapi.js';
import { PasskeyCheckRequiredSchema } from '../sessions/devices-openapi.js';

const TAGS = ['Auth'];

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const OWNER_ONLY = problemResponse(
  'Not the owner, in the app, at the computer DorkOS runs on or signed in over https ' +
    '(`operator_only`), or not signed in as the owner (`owner_only`)'
);

/** A change, refused anywhere but the computer DorkOS runs on. */
const AT_THIS_COMPUTER = problemResponse(
  'Not the owner, in the app, at the computer DorkOS runs on, never another device ' +
    '(`operator_only`, `owner_only`), or not from the app’s own page (`origin_not_allowed`)'
);

/** A fresh passkey check, when this computer has a passkey. */
const PASSKEY_CHECK = json(
  PasskeyCheckRequiredSchema,
  'This computer has a passkey: run this check, then send its response as passkey'
);

/** The passkey check can't run here. */
const PASSKEY_CONFLICT = problemResponse(
  'The check needs a passkey on this computer (`passkey_needed`), or one made at another of ' +
    'its addresses (`passkey_on_other_address`)'
);

const PASSKEY_REFUSED = problemResponse('The passkey check did not pass (`passkey_refused`)');

/** The first check that works from another device ends earlier sign-ins first. */
const NOT_SIGNED_OUT = problemResponse(
  'Other devices could not be signed out, so nothing was added (`internal_error`)'
);

const FactorSchema = z.object({
  id: z.string(),
  kind: z.enum(['totp', 'passkey']),
  label: z.string(),
  host: z.string().optional(),
  addedAt: z.string(),
  lastUsedAt: z.string().optional(),
  worksFromAway: z.boolean(),
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
      200: json(
        z.object({ factors: z.array(FactorSchema), everHadAway: z.boolean() }),
        'The sign-in checks, each saying whether it works from another device'
      ),
      403: OWNER_ONLY,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/owner-factors/passkeys/options',
    tags: TAGS,
    summary: 'Start adding a passkey',
    description:
      'After a passkey check when this computer has a passkey, then "Confirm it’s you": a ' +
      'challenge to make a passkey on this computer’s own address. The person is always ' +
      'verified. At this computer only.',
    request: { body: LabelBody },
    responses: {
      200: json(z.object({ options: z.unknown() }), 'The options to hand the browser'),
      401: PASSKEY_REFUSED,
      403: AT_THIS_COMPUTER,
      409: PASSKEY_CONFLICT,
      428: PASSKEY_CHECK,
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
      400: problemResponse('No passkey sent, or it was not added (`invalid_request`)'),
      403: AT_THIS_COMPUTER,
      500: NOT_SIGNED_OUT,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/owner-factors/authenticator/start',
    tags: TAGS,
    summary: 'Start adding an authenticator app',
    description:
      'After a passkey check when this computer has a passkey, then "Confirm it’s you": a ' +
      'new secret and the address an authenticator app scans. It counts only once one of ' +
      'its codes is confirmed.',
    request: { body: LabelBody },
    responses: {
      200: json(
        z.object({ id: z.string(), secret: z.string(), uri: z.string() }),
        'The new secret to scan'
      ),
      401: PASSKEY_REFUSED,
      403: AT_THIS_COMPUTER,
      409: PASSKEY_CONFLICT,
      428: PASSKEY_CHECK,
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
      400: problemResponse('The code did not match (`invalid_request`)'),
      403: AT_THIS_COMPUTER,
      404: problemResponse('Nothing waiting to confirm (`not_found`)'),
      500: NOT_SIGNED_OUT,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/owner-factors/{id}',
    tags: TAGS,
    summary: 'Remove a sign-in check',
    description:
      'After a passkey check when this computer has a passkey, then "Confirm it’s you": ' +
      'removes one passkey or authenticator app and raises a notice. Once one that works ' +
      'from another device has existed, a password alone never signs in from one again.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Removed' },
      401: PASSKEY_REFUSED,
      403: AT_THIS_COMPUTER,
      404: problemResponse('Already gone (`not_found`)'),
      409: PASSKEY_CONFLICT,
      428: PASSKEY_CHECK,
    },
  });
}
