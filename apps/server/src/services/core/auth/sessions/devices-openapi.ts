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
      'plain-http Wi-Fi.',
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
      'over https, never plain-http Wi-Fi.',
    responses: {
      200: json(SignOutEverywhereElseResultSchema, 'How many sign-ins ended'),
      401: SIGNED_OUT,
      403: PEOPLE_ONLY,
    },
  });
}
