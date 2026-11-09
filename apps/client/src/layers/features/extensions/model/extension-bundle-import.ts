import type { ExtensionModule } from '@dorkos/extension-api';

/** Import the bundle through the server's approval and integrity gate. */
export function importExtensionModule(url: string): Promise<ExtensionModule> {
  return import(/* @vite-ignore */ url) as Promise<ExtensionModule>;
}
