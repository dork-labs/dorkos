/**
 * The digest of what an extension's manifest says it gives agents (DOR-2685),
 * shared by the server lifecycle's restart key and the manager's re-scan.
 *
 * @module services/extensions/agent-tools/declaration-digest
 */
import { createHash } from 'node:crypto';
import type { ExtensionManifest } from '@dorkos/extension-api';
import { stableStringify } from '@dorkos/shared/capabilities';

/**
 * A digest of what an extension's manifest says it gives agents: its tools,
 * its skills, and the name every one of its tools is shown under. Part of
 * `buildSourceKey` (`extension-server-lifecycle.ts`), so an edit to `extension.json` that changes only
 * these (no version bump, no `server.ts` change) still restarts the extension
 * and re-registers its tools. Computed from the parsed manifest, so an edit
 * that only moves whitespace or reorders keys changes nothing.
 *
 * @param manifest - The parsed manifest.
 */
export function extensionDeclarationDigest(manifest: ExtensionManifest): string {
  return createHash('sha256')
    .update(
      stableStringify({
        name: manifest.name,
        tools: manifest.tools ?? null,
        skills: manifest.skills ?? null,
      })
    )
    .digest('hex');
}
