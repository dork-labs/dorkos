/**
 * The three connection lists under `/api/relay`, each a page at a time
 * (DOR-4982): the connections set up on this computer, the kinds that can be
 * connected, and the chat routes. Each answers through `answerPage`
 * (`lib/paging/hand-route-page.ts`), `cursor` and `limit` in the query.
 *
 * - Connections: in the order the config file holds them, as the list has
 *   always come. One added or removed while paging can repeat or be missed.
 * - Kinds: in the catalog's own order, the one the setup list shows. One
 *   added by a plugin while paging can repeat or be missed.
 * - Chat routes: newest first, by when each was made, the id breaking a tie.
 *
 * None of these differs by reader, so their cursors are plain.
 *
 * @module routes/relay-adapter-lists
 */
import type { Hono } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { answerPage } from '../lib/paging/hand-route-page.js';
import { listPosition } from '../lib/paging/keyset-page.js';
import { logger } from '../lib/logger.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { BINDINGS_STARTING } from './relay-problems.js';

/**
 * Mount the three lists. Register them before the `/:id` reads beside them.
 *
 * @param router - The connection routes.
 * @param adapterManager - The adapter lifecycle manager.
 */
export function registerAdapterListRoutes(router: Hono<ApiEnv>, adapterManager: AdapterManager) {
  router.get('/adapters/catalog', async (c) => {
    try {
      return await answerPage(c, {
        list: 'relay-adapter-catalog',
        noun: 'entries',
        read: () => adapterManager.getCatalog().map((entry, index) => ({ entry, index })),
        keyOf: ({ entry, index }) => [listPosition(index), entry.manifest.type],
        show: ({ entry }) => entry,
      });
    } catch (err) {
      logger.error('[relay] GET /adapters/catalog failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t list connections. Try again.' });
    }
  });

  router.get('/adapters', (c) =>
    answerPage(c, {
      list: 'relay-adapters',
      noun: 'adapters',
      read: () => adapterManager.listAdapters().map((row, index) => ({ row, index })),
      keyOf: ({ row, index }) => [listPosition(index), row.config.id],
      show: ({ row }) => row,
    })
  );

  router.get('/bindings', (c) => {
    const bindingStore = adapterManager.getBindingStore();
    if (!bindingStore) return problem(c, 'temporarily_unavailable', { detail: BINDINGS_STARTING });
    return answerPage(c, {
      list: 'relay-bindings',
      noun: 'bindings',
      read: () => bindingStore.getAll(),
      keyOf: (binding) => [binding.createdAt, binding.id],
    });
  });
}
