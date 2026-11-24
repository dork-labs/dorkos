/**
 * What `GET /api/links/target` takes and answers (DOR-5046): the `link.resolve`
 * capability behind the `/r/<dork-uri>` link (ADR 261122-124821).
 *
 * The server answers with the kind and the ids the app needs to open the thing,
 * never with an address in the app: the client builds that with its own route
 * factories, so the server never learns the app's URL shape and a link means
 * the same thing on the web, on the phone and on the desktop.
 *
 * A missing thing and a thing the caller may not see get the same refusal
 * (`LINK_NOT_FOUND`, a 404), so a link never confirms that anything exists.
 *
 * @module shared/dork-link-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The refusal code for every link that opens nothing: unknown, private, or malformed. */
export const LINK_NOT_FOUND_CODE = 'LINK_NOT_FOUND';

/**
 * What resolving a link takes. The `uri` is any string: one that is empty,
 * too long or no reference at all is answered `LINK_NOT_FOUND` like any other
 * link that opens nothing, never a different error that would tell a
 * malformed link from a private one.
 */
export const DorkLinkResolveRequestSchema = z
  .object({
    uri: z
      .string()
      .describe(
        'The dork: reference to open, such as dork:chat:<id>, dork:room:<id>, ' +
          'dork:entry:<id> or dork:agent:<id>. The part of a /r/ link after /r/.'
      ),
  })
  .openapi('DorkLinkResolveRequest');

/** What resolving a link takes. */
export type DorkLinkResolveRequest = z.infer<typeof DorkLinkResolveRequestSchema>;

/** What a link to one thing opens: which kind, and the ids that open it. */
export const ResolvedDorkLinkSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('chat'),
      sessionId: z
        .string()
        .describe(
          'The chat’s id now: a new chat’s first id is followed to the one its runtime gave it.'
        ),
    }),
    z.object({
      kind: z.literal('room'),
      roomId: z.string().describe('The room or DM.'),
    }),
    z.object({
      kind: z.literal('entry'),
      roomId: z.string().describe('The room the message is in.'),
      entryId: z.string().describe('The message.'),
      seq: z.number().int().positive().describe('Where it sits in the room, for scrolling to it.'),
      threadRootEntryId: z
        .string()
        .optional()
        .describe('The message a reply hangs under, when the message is a reply in a thread.'),
    }),
    z.object({
      kind: z.literal('agent'),
      agentId: z.string().describe('The agent’s mesh id.'),
    }),
  ])
  .openapi('ResolvedDorkLink');

/** What a link to one thing opens. */
export type ResolvedDorkLink = z.infer<typeof ResolvedDorkLinkSchema>;
