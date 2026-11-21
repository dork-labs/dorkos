import type { ExtensionManifest, ExtensionModule } from '@dorkos/extension-api';
import { isolatedExtensionModule } from '../frame/host';

/**
 * Fetch approved bytes as data; only an opaque frame may evaluate them.
 *
 * @param url - Where the bundle is served.
 * @param manifest - Its manifest, from DorkOS's records.
 * @param allowedSlots - The places DorkOS's record allows it now (DOR-4282).
 */
export async function importExtensionModule(
  url: string,
  manifest: ExtensionManifest,
  allowedSlots?: readonly string[]
): Promise<ExtensionModule> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The app bundle could not be read.');
  return isolatedExtensionModule(await response.text(), manifest, allowedSlots);
}
