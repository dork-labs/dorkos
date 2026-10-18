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

const TAGS = ['Hub'];

const ErrorSchema = z.object({ error: z.string(), code: z.string() });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const OWNER_ONLY = json(
  ErrorSchema,
  "Not the person's own browser sign-in: an agent or an API key never reaches these routes"
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
      404: json(ErrorSchema, 'Not a hub'),
      503: json(ErrorSchema, 'The hub is not serving yet'),
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
      404: json(ErrorSchema, 'Not a hub, or no such linked computer'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/hub/link',
    tags: TAGS,
    summary: 'Link a computer with a code',
    description:
      'Sent by DorkOS on the computer, never a browser, with no sign-in: the link code is the ' +
      "credential. The request is signed with the computer's own key; the answer carries the " +
      "hub's key and is signed with it. A wrong, expired or used code and a bad signature get " +
      'the same 401. A cloud agent computer redeems here too, under its relay id (`ac:` and ' +
      'its cloud computer id), with a code the hub minted for that computer alone; a second ' +
      'redeem for one computer unlinks it, mints a new code, and is refused with 409.',
    request: {
      body: { content: { 'application/json': { schema: RelayLinkRequestSchema } } },
    },
    responses: {
      200: json(RelayLinkResponseSchema, 'Linked'),
      400: json(ErrorSchema, 'Not a link request'),
      401: json(ErrorSchema, 'The code or the signature did not check out'),
      403: json(ErrorSchema, 'A browser sent it'),
      404: json(ErrorSchema, 'Not a hub'),
      409: json(
        ErrorSchema,
        "That computer id is already linked under another key, an agent computer's code was " +
          'redeemed twice (`LINK_RESET`), or the hub cannot link another'
      ),
      413: json(ErrorSchema, 'The body is over 4 KB'),
      429: json(ErrorSchema, 'Too many wrong codes lately, from anywhere'),
      503: json(ErrorSchema, 'The hub is not serving, or has no signing key yet'),
    },
  });
}
