/**
 * The key that switches the cockpit's persisted boot cache off for a session.
 *
 * Its own module because both the Playwright config (which seeds it into every
 * context's `storageState`) and the one spec that opts back in need it, and the
 * config cannot import the fixtures.
 *
 * Spelled here rather than imported from the client: `apps/e2e` depends on no
 * workspace package, and one string is not worth making it depend on the client
 * bundle. The value is pinned from the other side —
 * `apps/client/src/layers/shared/lib/__tests__/query-persister.test.ts` asserts
 * this exact literal and names this file — so a rename reddens a unit test that
 * says where to look.
 *
 * @module boot-cache-flag
 */

/** See {@link BOOT_CACHE_DISABLED_KEY} in `shared/lib/query-persister.ts`. */
export const BOOT_CACHE_DISABLED_KEY = 'dorkos:boot-cache-disabled';
