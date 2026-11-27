/**
 * OpenAPI entries for the mini app lists, each a page at a time (DOR-4982):
 * the installed mini apps, the ones waiting for a first yes, and the approvals
 * whose mini app is gone (DOR-3372). Removing a mini app and forgetting such
 * an approval are capabilities the mount describes from their own
 * declarations (DOR-4978); the waiting sets are described beside their routes
 * (`groups/extension-approval-set-openapi.ts`).
 *
 * @module services/extensions/listing/extension-list-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { PageQuerySchema } from '@dorkos/shared/paging';
import {
  ExtensionListPageSchema,
  PendingExtensionApprovalsPageSchema,
  StaleExtensionApprovalsPageSchema,
} from '@dorkos/shared/extension-list-schemas';
import { problemResponse as error } from '../../core/openapi/problem-openapi.js';

/** What every mini app list says about paging. */
export const EXTENSION_PAGES =
  ' A page at a time: pass `nextCursor` back as `cursor` for the next; a cursor this list did ' +
  'not give is refused with `400 invalid_request`.';

/** The `400` a mini app list answers for a bad query or cursor. */
export const PAGE_REFUSED = error(
  '`invalid_request`: `limit` is out of range, the query has another field, or the cursor was ' +
    'not given by this list'
);

/**
 * Register the installed mini app list, the list waiting for a first yes, and
 * the approvals left behind.
 *
 * @param registry - The OpenAPI registry.
 */
export function registerExtensionListOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/extensions',
    tags: ['Extensions'],
    summary: 'List installed extensions',
    description:
      'Every extension DorkOS found, with where it stands: each copy that runs, by id Z to A, ' +
      'then each older copy a newer one from the same trusted source shadows, with `shadowedBy` ' +
      'set. An extension installed, removed or rescanned while paging can repeat or be missed.' +
      EXTENSION_PAGES,
    request: { query: PageQuerySchema },
    responses: {
      200: {
        description: 'One page of installed extensions',
        content: { 'application/json': { schema: ExtensionListPageSchema } },
      },
      400: PAGE_REFUSED,
      500: error('`internal_error`: the list could not be read'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/extensions/pending-approvals',
    tags: ['Extensions'],
    summary: 'List extensions waiting to be turned on',
    description:
      'Every installed extension that is waiting for a person to let it run, newest waiting ' +
      'first (DOR-2517). An extension is listed when it was installed by a person or the ' +
      'marketplace (DorkOS’s own never ask), is not turned off, may not run yet, and has not been ' +
      'declined with "Not now" at its current path, plugin and version. The Activity inbox draws ' +
      'one row per item. `sourceLabel` and `why` are display text and are never used to decide ' +
      'trust. A caller that may not read the person’s inbox (an agent) gets the list without ' +
      '`path` and without any folder in `sourceLabel`, and its cursors are its own. One answered ' +
      'while paging, or one whose wait restarts when DorkOS does, can repeat or be missed.' +
      EXTENSION_PAGES,
    request: { query: PageQuerySchema },
    responses: {
      200: {
        description: 'One page of extensions waiting to be turned on',
        content: { 'application/json': { schema: PendingExtensionApprovalsPageSchema } },
      },
      400: PAGE_REFUSED,
      500: error('`internal_error`: the list could not be read'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/extensions/stale-approvals',
    tags: ['Extensions'],
    summary: 'List approvals whose extension is no longer installed',
    description:
      'Every extension id that still has a run approval, approved source or permission set ' +
      'recorded although no copy of it is installed anywhere. Settings shows each as "Folder ' +
      'missing" with Forget. Paths are only sent to the person, and a cursor is bound to the ' +
      'kind of reader it was given to. By id, Z to A; one forgotten or reinstalled while paging ' +
      'can repeat or be missed.' +
      EXTENSION_PAGES,
    request: { query: PageQuerySchema },
    responses: {
      200: {
        description: 'One page of the approvals left behind',
        content: { 'application/json': { schema: StaleExtensionApprovalsPageSchema } },
      },
      400: PAGE_REFUSED,
      500: error('`internal_error`: the list could not be read'),
    },
  });
}
