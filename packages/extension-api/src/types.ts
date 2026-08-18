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
  /**
   * A failure to rebuild the SERVER entry (`server.ts`) while a previous version
   * of it is still mounted and answering requests.
   *
   * Deliberately NOT `status`/`error`: those are one field each for the whole
   * extension, and `status` is what `ExtensionManager.readBundle` and the client
   * loader gate the CLIENT bundle on. Writing `compile_error` there for a
   * server-side failure would take the extension's perfectly good UI off the
   * screen in every new tab — a bigger break than the one being reported. This
   * field says the narrower, true thing: the running server code no longer
   * matches its source. Cleared when a fixed version takes over.
   */
  serverError?: { code: string; message: string; details?: string };
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
  /**
   * The extension's server half failed to rebuild and the previously loaded
   * version is still running. The cockpit shows this as a warning line beside an
   * otherwise healthy extension — `status` and `bundleReady` are untouched, so
   * the client bundle keeps loading. See {@link ExtensionRecord.serverError}.
   */
  serverError?: { code: string; message: string; details?: string };
  bundleReady: boolean;
  hasServerEntry: boolean;
  hasDataProxy: boolean;
  /**
   * Whether a person has approved this extension to RUN CODE inside the DorkOS
   * server process (DOR-516). Always `true` for `origin: 'core'`, which ships with
   * DorkOS and never needs approving.
   *
   * `false` means DorkOS will compile this extension and report real errors, but
   * will not execute it in-process. The cockpit surfaces that as a per-extension
   * Approve control rather than an error, because nothing is broken — it is
   * waiting on a person.
   */
  approvedToRun: boolean;
}

/** The interface an extension module must export. */
export interface ExtensionModule {
  activate(api: import('./extension-api.js').ExtensionAPI): void | (() => void);
}
