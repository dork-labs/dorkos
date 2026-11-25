/**
 * OpenAPI entries for linking a computer to a hub (step B3, DOR-2946): the
 * owner minting a link code and unlinking a computer
 * (`routes/hub-computer-links.ts`), and a computer redeeming the code
 * (`routes/hub-link.ts`). Bodies are the protocol's own
 * (`@dorkos/shared/session-relay-link`).
 *
 * @module services/core/hub-relay/hub-link-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  HubLinkCodeSchema,
  RelayLinkRequestSchema,
  RelayLinkResponseSchema,
} from '@dorkos/shared/session-relay-link';
import { problemResponse } from '../openapi/problem-openapi.js';

const TAGS = ['Hub'];

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const OWNER_ONLY = problemResponse(
  "Not the person's own browser sign-in (`person_only`): an agent or an API key never " +
    'reaches these routes'
);

/**
 * Register the hub's link routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerHubLinkOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/hub/computers/link-code',
    tags: TAGS,
    summary: 'Make a code to link a computer',
    description:
      "On a hub, for its owner's own browser sign-in: a one-time code, good for ten minutes, " +
      "with the hub's host folded in (`<code>@<host>`). The owner pastes it into DorkOS on the " +
      'computer to link. At most three are outstanding; another drops the oldest.',
    responses: {
      200: json(HubLinkCodeSchema, 'The code, and when it stops working'),
      403: OWNER_ONLY,
      404: problemResponse('Not a hub (`not_found`)'),
      503: problemResponse('The hub is not serving yet (`temporarily_unavailable`)'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/hub/computers/{computerId}',
    tags: TAGS,
    summary: 'Unlink a computer',
    description:
      "On a hub, for its owner's own browser sign-in: forgets the computer, so its relay " +
      'secret stops working, and ends anything it has open on the hub now.',
    request: { params: z.object({ computerId: z.string() }) },
    responses: {
      204: { description: 'Unlinked' },
      403: OWNER_ONLY,
      404: problemResponse('Not a hub, or no such linked computer (`not_found`)'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/hub/link',
    tags: TAGS,
    summary: 'Link a computer with a code',
    description:
      'Open only on a hub; on a computer it asks for a sign-in like anywhere ' +
      'else. Sent by DorkOS on the computer, never a browser, with no sign-in: the link code is the ' +
      "credential. The request is signed with the computer's own key; the answer carries the " +
      "hub's key and is signed with it. A wrong, expired or used code and a bad signature get " +
      'the same 401.',
    request: {
      body: { content: { 'application/json': { schema: RelayLinkRequestSchema } } },
    },
    responses: {
      200: json(RelayLinkResponseSchema, 'Linked'),
      400: problemResponse('Not a link request (`invalid_request`, `malformed_request`)'),
      401: problemResponse('The code or the signature did not check out (`link_code_refused`)'),
      403: problemResponse('A browser sent it (`forbidden`)'),
      404: problemResponse('Not a hub (`not_found`)'),
      409: problemResponse(
        'That computer id is already linked under another key (`already_linked`), or the hub ' +
          'cannot link another (`computer_limit_reached`)'
      ),
      413: problemResponse('The body is over 4 KB (`request_too_large`)'),
      429: problemResponse('Too many wrong codes lately, from anywhere (`rate_limited`)'),
      503: problemResponse(
        'The hub is not serving, or has no signing key yet (`temporarily_unavailable`)'
      ),
    },
  });
}
