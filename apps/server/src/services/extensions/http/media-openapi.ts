/**
 * OpenAPI entries for an app's video links (DOR-4321): the ticket mint and
 * the route a frame's `<video>` loads (`routes/extension-media.ts`).
 *
 * @module services/extensions/http/media-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

const MediaTicketBodySchema = z
  .object({
    path: z
      .string()
      .max(4000)
      .describe(
        'The path below the app, e.g. `/videos/intro.mp4`. No query, no empty, `.` or `..` part, ' +
          'and no `%`, `\\`, `#` or control character.'
      ),
  })
  .openapi('ExtensionMediaTicketRequest');

const MediaTicketSchema = z
  .object({
    url: z
      .string()
      .describe('Where the video plays: `/api/extensions/media/<ticket>`, on this server.'),
  })
  .openapi('ExtensionMediaTicket');

/** What every media answer carries, whatever the app sent. */
const FORCED =
  'Every answer carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; ' +
  "default-src 'none'`, `Content-Disposition: inline`, `Cache-Control: private, no-store`, " +
  '`Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: cross-origin`.';

/**
 * Register the video-link routes.
 *
 * @param registry - The OpenAPI registry.
 */
export function registerExtensionMediaOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/extensions/{id}/media-tickets',
    tags: ['Extensions'],
    summary: 'Get a video link for an app’s frame',
    description:
      'What `api.mediaUrl(path)` asks for. Only a person’s DorkOS window may ask: the request must ' +
      'name a trusted `Origin`, and an agent or an API key is refused. The app must use the ' +
      'frame (`clientApiVersion: 2`), declare `capabilities.http`, and be running with a `fetch` ' +
      'handler or in its own process. The link works for 10 minutes after its last use and 2 ' +
      'hours at most, an app keeps 16, and every link of an app ends when it stops, reloads or ' +
      'updates. It plays that one path and acts as no person.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: MediaTicketBodySchema } } },
    },
    responses: {
      201: {
        description: 'The video link',
        content: { 'application/json': { schema: MediaTicketSchema } },
      },
      400: error('Invalid extension id, or a path that is not plainly inside the app'),
      401: error('Login is enabled and the caller is not signed in'),
      403: error('Not a person’s DorkOS window, or a write stamped by another app'),
      404: error('The app is not running, does not use the frame, or cannot stream video'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/extensions/media/{ticket}',
    tags: ['Extensions'],
    summary: 'Play an app’s video by its link',
    description:
      'Needs no sign-in: the ticket is the credential. DorkOS asks the app’s own route for the ' +
      'ticket’s path with only `Range` and `If-Range`, tells the app its caller is not a person, ' +
      'and streams the answer. A query string is ignored. `HEAD` answers the headers only; any ' +
      'other method is answered `405`. Only `200`, `206` and `416` pass, a success must be ' +
      '`video/mp4` or `video/webm`, and only `Content-Type`, `Content-Length`, `Content-Range`, ' +
      '`Accept-Ranges`, `ETag` and `Last-Modified` cross from the app. ' +
      FORCED,
    request: {
      params: z.object({ ticket: z.string() }),
      headers: z.object({ range: z.string().optional(), 'if-range': z.string().optional() }),
    },
    responses: {
      200: {
        description: 'The whole video',
        content: {
          'video/mp4': { schema: z.string().openapi({ format: 'binary' }) },
          'video/webm': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
      206: { description: 'The range asked for' },
      404: error('The link is unknown or has expired (the same answer for both)'),
      405: error('Only GET and HEAD'),
      415: { description: 'The app answered with something that is not MP4 or WebM' },
      416: { description: 'The range asked for is not in the video' },
      502: { description: 'The app did not answer, or answered with another status' },
    },
  });
}
