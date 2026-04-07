/**
 * Dork Hub built-in extension — server entry.
 *
 * The marketplace HTTP API is registered globally in
 * `apps/server/src/routes/marketplace.ts` (spec marketplace-02-install),
 * so this entry exists only to satisfy the extension server lifecycle
 * contract. It performs no additional registration.
 *
 * The extension server lifecycle (`extension-server-lifecycle.ts`) calls
 * the default export as `register(router, ctx)`. We accept the parameters
 * to keep the signature compatible with the loader, but neither attaches
 * routes nor schedules background work.
 *
 * @module builtin-extensions/marketplace/server
 */
import type { Router } from 'express';
import type { DataProviderContext } from '@dorkos/extension-api/server';

/**
 * Register server-side capabilities for the Dork Hub extension.
 *
 * Intentionally a no-op — the marketplace API is host-mounted globally,
 * not extension-scoped. See the module-level comment for context.
 *
 * @param _router - Scoped Express router (unused).
 * @param _ctx - Data provider context (unused).
 */
export default function register(_router: Router, _ctx: DataProviderContext): void {
  // No-op: marketplace API is globally mounted, not extension-scoped.
}
