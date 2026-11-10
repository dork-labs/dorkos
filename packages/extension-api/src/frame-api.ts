import type { ExtensionAPI } from './extension-api.js';

/**
 * The global a compiled client bundle assigns its exports to.
 *
 * Client bundles are classic scripts that run inside an app's sandboxed frame,
 * so the frame reads `activate` from this name instead of importing a module.
 */
export const EXTENSION_BUNDLE_GLOBAL = '__dorkosExtension';

/** Version 2 browser API, available only inside an app's isolated frame. */
export interface FrameExtensionAPI extends Omit<ExtensionAPI, 'executeCommand' | 'openCanvas'> {
  /** Activation runs once for registrations and once per mounted view. Keep startup work in registration. */
  readonly context: 'registration' | 'view';
  /** Request JSON from this app's own server router. Requires capabilities.http. */
  request<T = unknown>(
    path: string,
    options?: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
    }
  ): Promise<T>;
  /** Read this app's non-secret manifest settings. */
  readonly settings: { get<T = unknown>(): Promise<T> };
}
