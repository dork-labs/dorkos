/**
 * Marketplace built-in extension — client entry.
 *
 * The Marketplace UI lives in the client codebase under FSD layers
 * (`apps/client/src/layers/features/marketplace/` and
 * `apps/client/src/layers/widgets/marketplace/`) and is wired into the
 * router at `/marketplace`. Its sidebar entry is a HARDCODED `NavButton`
 * in `DashboardSidebar`, NOT a registry slot contribution — nothing
 * about this extension's enabled state affects the host UI. That is why
 * the manifest declares `canDisable: false`: until Marketplace is rebuilt
 * as a real extension (DOR-122), a toggle would be a no-op lie, so the
 * settings UI renders a "Required" lock instead.
 *
 * This file is intentionally minimal: the activate function is a no-op
 * because the corresponding React components are bundled with the host
 * client rather than shipped through the extension bundle. The contract
 * is satisfied so the extension test harness can verify the extension
 * loads cleanly during compile-time checks.
 *
 * @module core-extensions/marketplace/index
 */
import type { ExtensionAPI } from '@dorkos/extension-api';

/**
 * Activate the Marketplace built-in extension.
 *
 * Intentionally a no-op — see the module-level comment for the rationale.
 * The signature exists to satisfy the extension test harness contract,
 * which verifies that every extension exports an `activate(api)` function.
 *
 * @param _api - Host-provided extension API (unused).
 */
export function activate(_api: ExtensionAPI): void {
  // No-op: Marketplace UI is host-bundled, not extension-bundled.
}
