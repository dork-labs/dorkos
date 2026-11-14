import type { ExtensionManifest, ExtensionModule } from '@dorkos/extension-api';
import { isolatedExtensionModule } from '../frame/host';

/** Fetch approved bytes as data; only an opaque frame may evaluate them. */
export async function importExtensionModule(
  url: string,
  manifest: ExtensionManifest
): Promise<ExtensionModule> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The app bundle could not be read.');
  return isolatedExtensionModule(await response.text(), manifest);
}
