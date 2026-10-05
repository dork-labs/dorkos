/**
 * Whether an extension folder carries a server half, read the way discovery
 * reads it (`extension-discovery.ts` `detectServerEntry`): a declared data
 * proxy, or the server entry file (the declared path, or its `.js` twin).
 * Used where a card describes an extension that is not installed yet (the
 * install preview, a dev link), so a screens-only extension is never
 * described as having full access to the computer (DOR-2686).
 *
 * @module services/extensions/isolation/server-half
 */
import fs from 'fs/promises';
import path from 'path';
import type { ExtensionManifest } from '@dorkos/extension-api';

/** Whether a file exists at `target` (any kind; nothing is read). */
async function present(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the extension in `extDir` has a server half.
 *
 * @param extDir - The extension's folder.
 * @param manifest - Its parsed `extension.json`.
 */
export async function hasServerHalf(extDir: string, manifest: ExtensionManifest): Promise<boolean> {
  if (manifest.dataProxy) return true;
  const entry = path.join(extDir, manifest.serverCapabilities?.serverEntry ?? './server.ts');
  if (await present(entry)) return true;
  return entry.endsWith('.ts') && present(entry.replace(/\.ts$/, '.js'));
}
