/**
 * Marketplace confirmation provider singleton — bridges the boot-time
 * confirmation provider construction in `apps/server/src/index.ts` with the
 * out-of-band HTTP route added by task 4.2 (`POST
 * /api/marketplace/confirmations/:token`).
 *
 * The MCP install/uninstall/create-package tools are gated by a
 * `ConfirmationProvider` (see `./confirmation-provider.ts`). When the active
 * provider is the {@link TokenConfirmationProvider}, an external MCP client
 * receives a token and the user must approve or decline that token from the
 * DorkOS UI. The HTTP route handling that approval lives in the marketplace
 * router, which has no direct reference to the provider built at boot — this
 * tiny module-level singleton is the only thing they share.
 *
 * Lifecycle:
 *
 * 1. `index.ts` constructs the appropriate provider during marketplace wiring.
 * 2. `index.ts` calls {@link setMarketplaceConfirmationProvider} once.
 * 3. The marketplace router calls {@link getMarketplaceConfirmationProvider}
 *    on every confirmation request and resolves/rejects the token.
 *
 * The singleton is intentionally module-scoped (not a class) because there is
 * exactly one server boot per process and tests can simply re-call the setter
 * with a fresh provider per test.
 *
 * @module services/marketplace-mcp/confirmation-registry
 */
import type { ConfirmationProvider } from './confirmation-provider.js';

/**
 * The active provider, or `null` before {@link setMarketplaceConfirmationProvider}
 * has been called (e.g. when marketplace services are disabled because the
 * relay is not initialized).
 */
let provider: ConfirmationProvider | null = null;

/**
 * Register the active marketplace confirmation provider. Called once at server
 * boot from `apps/server/src/index.ts` after the provider is constructed.
 *
 * @param next - The provider to install as the singleton.
 */
export function setMarketplaceConfirmationProvider(next: ConfirmationProvider): void {
  provider = next;
}

/**
 * Look up the active marketplace confirmation provider.
 *
 * Returns `null` when the marketplace surface is not wired (e.g. relay
 * disabled). Callers — typically the `POST /api/marketplace/confirmations/:token`
 * route — should respond with HTTP 503 when this returns `null`.
 *
 * @returns The registered provider, or `null` if none has been set yet.
 */
export function getMarketplaceConfirmationProvider(): ConfirmationProvider | null {
  return provider;
}

/**
 * Clear the registered provider. Test-only helper — production code never
 * needs to unset the singleton because the process exits on shutdown.
 *
 * @internal Exported for testing only.
 */
export function clearMarketplaceConfirmationProvider(): void {
  provider = null;
}
