/**
 * Dork Hub built-in extension — client entry.
 *
 * The Dork Hub UI lives in the client codebase under FSD layers
 * (`apps/client/src/layers/features/marketplace/` and
 * `apps/client/src/layers/widgets/marketplace/`) and is wired into the
 * router at `/marketplace`. The sidebar tab that links to that route is
 * registered here so the host's slot machinery (`useSlotContributions`)
 * can surface it alongside other extension-contributed tabs.
 *
 * This file is intentionally minimal: the activate function is a no-op
 * because the corresponding React components are bundled with the host
 * client rather than shipped through the extension bundle. The contract
 * is satisfied so the extension test harness can verify the extension
 * loads cleanly during compile-time checks.
 *
 * @module builtin-extensions/marketplace/index
 */
import type { ExtensionAPI } from '@dorkos/extension-api';

/**
 * Activate the Dork Hub built-in extension.
 *
 * Intentionally a no-op — see the module-level comment for the rationale.
 * The signature exists to satisfy the extension test harness contract,
 * which verifies that every extension exports an `activate(api)` function.
 *
 * @param _api - Host-provided extension API (unused).
 */
export function activate(_api: ExtensionAPI): void {
  // No-op: Dork Hub UI is host-bundled, not extension-bundled.
}
