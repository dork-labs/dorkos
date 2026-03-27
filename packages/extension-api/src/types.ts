import type { ExtensionManifest } from './manifest-schema.js';

/** Lifecycle status of a discovered extension. */
export type ExtensionStatus =
  | 'discovered'
  | 'incompatible'
  | 'invalid'
  | 'disabled'
  | 'enabled'
  | 'compiled'
  | 'compile_error'
  | 'active'
  | 'activate_error';

/** Server-side record for a discovered extension. */
export interface ExtensionRecord {
  id: string;
  manifest: ExtensionManifest;
  status: ExtensionStatus;
  scope: 'global' | 'local';
  /** Absolute path to the extension directory. */
  path: string;
  /** Structured error info (compilation failure, manifest parse error, etc.) */
  error?: { code: string; message: string; details?: string };
  /** Content hash of the source file (for cache keying). */
  sourceHash?: string;
  /** Whether the compiled bundle is available on the server. */
  bundleReady: boolean;
}

/** The subset of ExtensionRecord sent to the client (excludes server-internal fields). */
export interface ExtensionRecordPublic {
  id: string;
  manifest: ExtensionManifest;
  status: ExtensionStatus;
  scope: 'global' | 'local';
  error?: { code: string; message: string; details?: string };
  bundleReady: boolean;
}

/** The interface an extension module must export. */
export interface ExtensionModule {
  activate(api: import('./extension-api.js').ExtensionAPI): void | (() => void);
}
