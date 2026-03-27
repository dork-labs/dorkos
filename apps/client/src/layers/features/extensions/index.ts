/**
 * Extensions feature — third-party extension lifecycle and settings UI.
 *
 * Provides the `ExtensionProvider` context that loads compiled extensions on
 * mount, `useExtensions()` for consuming extension state, `ExtensionLoader`
 * for the fetch-import-activate lifecycle, and `createExtensionAPI()` for
 * constructing per-extension API objects wrapping host primitives.
 *
 * @module features/extensions
 */
export { ExtensionProvider, useExtensions } from './model/extension-context';
export type { ExtensionContextValue } from './model/extension-context';
export { createExtensionAPI } from './model/extension-api-factory';
export { ExtensionLoader } from './model/extension-loader';
export type { LoadedExtension, ExtensionAPIDeps } from './model/types';
export { ExtensionsSettingsTab } from './ui/ExtensionsSettingsTab';
