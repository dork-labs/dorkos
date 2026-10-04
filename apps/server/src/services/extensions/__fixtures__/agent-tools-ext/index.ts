/**
 * Client half of the agent-tools fixture extension (DOR-2685). It adds
 * nothing to the screen: the fixture exists for its server-side tools.
 */
import type { ExtensionAPI } from '@dorkos/extension-api';

/**
 * Activate the fixture's client half, which contributes nothing.
 *
 * @param _api - The extension API; unused.
 */
export function activate(_api: ExtensionAPI): void {}
