/**
 * OpenAPI entries for the web push routes (`routes/push.ts`, spec
 * `notification-system` task 4.3, ADR 260819-234829): the key a browser needs
 * to subscribe, and the browsers DorkOS may push to, listed a page at a time
 * (DOR-4982). Every route is the operator's, the reads too.
 *
 * @module services/core/openapi/push-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  DeletePushSubscriptionResponseSchema,
  ListPushSubscriptionsResponseSchema,
  RegisterPushSubscriptionRequestSchema,
  RegisterPushSubscriptionResponseSchema,
  VapidPublicKeyResponseSchema,
} from '@dorkos/shared/notification-schemas';
import { PageQuerySchema } from '@dorkos/shared/paging';
import { problemResponse } from './problem-openapi.js';

/**
 * Register the web push paths.
 *
 * @param registry - The document's registry.
 */
export function registerPushOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/push/vapid-public-key',
    tags: ['Notifications'],
    summary: 'Read the VAPID public key a browser needs to subscribe',
    description:
      'Generates this install’s keypair on the first call. Answers `key: null` when web push ' +
      'is unavailable here, so a client can say so instead of offering a button that fails.',
    responses: {
      200: {
        description: 'The public key, or null',
        content: { 'application/json': { schema: VapidPublicKeyResponseSchema } },
      },
      403: problemResponse('`operator_only`: only the operator may see this install’s push setup'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/push/subscriptions',
    tags: ['Notifications'],
    summary: 'List the browsers DorkOS may push to',
    description:
      'Never returns an endpoint, only the push service’s hostname and the dates. Newest ' +
      'subscribed first, the id breaking a tie, a page at a time: pass `nextCursor` back as ' +
      '`cursor` for the next. A cursor this list did not give is refused with `400 ' +
      'invalid_request`. A browser added or removed while paging can repeat or be missed.',
    request: { query: PageQuerySchema },
    responses: {
      200: {
        description: 'One page of subscribed browsers, newest first',
        content: { 'application/json': { schema: ListPushSubscriptionsResponseSchema } },
      },
      400: problemResponse('`invalid_request`: a bad `limit`, or a cursor this list did not give'),
      403: problemResponse('`operator_only`: only the operator may list push devices'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/push/subscriptions',
    tags: ['Notifications'],
    summary: 'Let DorkOS push to this browser',
    description:
      'Idempotent by endpoint, so a client may call it on every load to refresh keys the ' +
      'browser rotated without accumulating dead rows.',
    request: {
      body: {
        content: { 'application/json': { schema: RegisterPushSubscriptionRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'The subscription as it now stands',
        content: { 'application/json': { schema: RegisterPushSubscriptionResponseSchema } },
      },
      400: problemResponse('Validation error'),
      403: problemResponse('`operator_only`: only the operator may subscribe a device'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/push/subscriptions/{id}',
    tags: ['Notifications'],
    summary: 'Stop pushing to one browser',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'How many rows went away — 0 when it was already gone',
        content: { 'application/json': { schema: DeletePushSubscriptionResponseSchema } },
      },
      403: problemResponse('`operator_only`: only the operator may remove a push device'),
    },
  });
}
