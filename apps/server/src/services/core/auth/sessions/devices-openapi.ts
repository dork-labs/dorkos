/**
 * OpenAPI entries for a person's own signed-in devices (F4 part 2, DOR-2969,
 * `routes/devices.ts`). Bodies are the shared schemas
 * (`@dorkos/shared/signed-in-devices`).
 *
 * @module services/core/auth/sessions/devices-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  SignedInDeviceListSchema,
  SignOutEverywhereElseResultSchema,
  WifiSignInApprovalSchema,
  WifiSignInRequestListSchema,
} from '@dorkos/shared/signed-in-devices';

const TAGS = ['Devices'];

const ErrorSchema = z.object({ error: z.string(), code: z.string() });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const PEOPLE_ONLY = json(
  ErrorSchema,
  'An agent, a per-user API key or the relay (`DEVICES_PEOPLE_ONLY`), or, for a write that ' +
    'needs it, not the owner at the computer DorkOS runs on or signed in over https ' +
    '(`NEEDS_PERSON_AT_THIS_COMPUTER`)'
);
const SIGNED_OUT = json(ErrorSchema, 'Not signed in');

/** The passkey check a 428 hands back: one named component for both routes that send it. */
const PasskeyCheckRequiredSchema = z
  .object({ code: z.string(), options: z.unknown() })
  .openapi('PasskeyCheckRequired');

/**
 * Register the devices routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerDevicesOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/devices/sessions',
    tags: TAGS,
    summary: 'Your signed-in devices',
    description:
      "The signed-in person's own live sign-ins: how each came in, when it was made and last " +
      'used, and which one is asking. Each is named by an opaque id, never its token. A person ' +
      "at this computer whose gate asks for no password sees the owner's.",
    responses: {
      200: json(SignedInDeviceListSchema, 'The sign-ins, the asking one first'),
      401: SIGNED_OUT,
      403: PEOPLE_ONLY,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/devices/sessions/{id}',
    tags: TAGS,
    summary: 'Sign out one device',
    description:
      'Ends one sign-in, closes every stream, socket and terminal it had open, and stops ' +
      'the chats it started. Your own current sign-in from anywhere; any other only from ' +
      'the owner at the computer DorkOS runs on or signed in over https, never ' +
      'from a plain-http network sign-in.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Signed out' },
      401: SIGNED_OUT,
      403: PEOPLE_ONLY,
      404: json(ErrorSchema, 'No live sign-in of yours has that id'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/devices/sign-out-all',
    tags: TAGS,
    summary: 'Sign out everywhere else',
    description:
      'Ends every sign-in but the asking one (all of them when the asker has none) and closes ' +
      'what each had open. Only from the owner at the computer DorkOS runs on or signed in ' +
      'over https, never from a plain-http network sign-in.',
    responses: {
      200: json(SignOutEverywhereElseResultSchema, 'How many sign-ins ended'),
      401: SIGNED_OUT,
      403: PEOPLE_ONLY,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/devices/sessions/{id}/runs-agents',
    tags: TAGS,
    summary: 'Let a device on the network run agents',
    description:
      'Lets one network sign-in start turns at the agent’s own level, or stops it. Every ' +
      'sign-in starts with this off. Only the owner at the computer DorkOS runs on may ' +
      'change it, from the app’s own page. Turning it on needs a fresh passkey check, as ' +
      'approving a sign-in does: the first call answers `428` (`PASSKEY_CHECK_REQUIRED`), the ' +
      'second sends `{ on, passkey }`. It ends when the device signs out or sits unused for ' +
      '12 hours.',
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ on: z.boolean(), passkey: z.unknown().optional() }),
          },
        },
      },
    },
    responses: {
      204: { description: 'Changed' },
      401: json(ErrorSchema, 'Not signed in, or the passkey check did not pass'),
      403: PEOPLE_ONLY,
      404: json(ErrorSchema, 'No live network sign-in of yours has that id'),
      409: json(ErrorSchema, 'Add a passkey on this computer first'),
      428: json(
        PasskeyCheckRequiredSchema,
        'Run this passkey check, then call again with its response'
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/devices/sign-in-requests',
    tags: TAGS,
    summary: 'Devices asking to sign in over the network',
    description:
      'Devices on the network waiting for the owner to approve their sign-in: what each says it ' +
      'is, its address and when it asked. Only for the owner at the computer DorkOS runs on.',
    responses: {
      200: json(WifiSignInRequestListSchema, 'The waiting requests, newest first'),
      401: SIGNED_OUT,
      403: PEOPLE_ONLY,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/devices/sign-in-requests/{id}/approve',
    tags: TAGS,
    summary: 'Approve a network sign-in',
    description:
      'Approves one waiting device and answers a one-time code to type on it. The first ' +
      'call answers `428` with a passkey check (`PASSKEY_CHECK_REQUIRED`); the second ' +
      'sends `{ passkey }`, the browser’s response to it. Each check approves one request ' +
      'once. With no passkey on this computer it answers `409` (`PASSKEY_NEEDED`). Only for ' +
      'the owner at the computer DorkOS runs on, from the app’s own page.',
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { 'application/json': { schema: z.object({ passkey: z.unknown().optional() }) } },
      },
    },
    responses: {
      200: json(WifiSignInApprovalSchema, 'Approved: the code to type on the device'),
      401: json(ErrorSchema, 'The passkey check did not pass'),
      403: PEOPLE_ONLY,
      404: json(ErrorSchema, 'That request has ended'),
      409: json(ErrorSchema, 'Add a passkey on this computer first'),
      428: json(
        PasskeyCheckRequiredSchema,
        'Run this passkey check, then call again with its response'
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/devices/sign-in-requests/{id}/decline',
    tags: TAGS,
    summary: 'Decline a network sign-in',
    description:
      'Turns one waiting device away. Only for the owner at the computer DorkOS runs on.',
    request: { params: z.object({ id: z.string() }) },
    responses: { 204: { description: 'Declined' }, 401: SIGNED_OUT, 403: PEOPLE_ONLY },
  });
}
