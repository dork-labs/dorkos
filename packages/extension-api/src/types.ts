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
  /**
   * Whether this extension ships with DorkOS (`'core'`) or was installed by the
   * user (`'user'`). Derived from the startup staging set (the ids
   * `ensureCoreExtensions()` staged), not from any manifest claim.
   */
  origin: 'core' | 'user';
  /** Absolute path to the extension directory. */
  path: string;
  /** Structured error info (compilation failure, manifest parse error, etc.) */
  error?: { code: string; message: string; details?: string };
  /** Content hash of the source file (for cache keying). */
  sourceHash?: string;
  /** Whether the compiled bundle is available on the server. */
  bundleReady: boolean;
  /** Whether the extension has a server.ts entry point on disk. */
  hasServerEntry: boolean;
  /** Whether the extension has a dataProxy manifest declaration. */
  hasDataProxy: boolean;
  /** Absolute path to the resolved server entry point (if hasServerEntry is true). */
  serverEntryPath?: string;
}

/** The subset of ExtensionRecord sent to the client (excludes server-internal fields). */
export interface ExtensionRecordPublic {
  id: string;
  manifest: ExtensionManifest;
  status: ExtensionStatus;
  scope: 'global' | 'local';
  /** Whether this extension ships with DorkOS (`'core'`) or was installed by the user (`'user'`). */
  origin: 'core' | 'user';
  error?: { code: string; message: string; details?: string };
  bundleReady: boolean;
  hasServerEntry: boolean;
  hasDataProxy: boolean;
}

/** The interface an extension module must export. */
export interface ExtensionModule {
  activate(api: import('./extension-api.js').ExtensionAPI): void | (() => void);
}
