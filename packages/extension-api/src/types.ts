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

/**
 * Where a copy of an extension came from, when this machine can prove it: the
 * plugin that carries it and the normalized `owner/repo` it was installed from.
 */
export interface ExtensionOrigin {
  /** The plugin folder that carries the extension. */
  plugin: string;
  /** The normalized `owner/repo`, e.g. `dork-labs/marketplace`. */
  source: string;
}

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
  /**
   * The installed marketplace plugin this extension came inside, when it was
   * found under `plugins/<name>/.dork/extensions/` rather than installed
   * directly. Part of the copy's identity: a person's approval to run it is
   * bound to this plugin and {@link ExtensionRecord.path}, so another plugin
   * carrying the same id asks again.
   */
  sourcePlugin?: string;
  /**
   * Where this copy provably came from: its plugin and the `owner/repo`
   * DorkOS's own installer recorded fetching it from (spec
   * `flow-multiproject` §9.1). Absent when DorkOS cannot prove it, which is
   * always the case for a copy placed directly or committed into a repo.
   * Never read from a file inside a project.
   */
  trustedOrigin?: ExtensionOrigin;
  /**
   * Why a copy the installer recorded has no trusted origin: `changed` (a
   * project copy whose plugin folder no longer holds what DorkOS installed,
   * or now holds a symbolic link) or `linked` (a global plugin holding a
   * symbolic link). A `changed` copy runs only while a person's yes names its
   * files exactly as they are now.
   */
  originProblem?: 'changed' | 'linked';
  /**
   * The whole plugin folder's digest now, for a `changed` copy: what a
   * person's approval of it is pinned to.
   */
  currentDigest?: string;
  /**
   * Where this copy RUNS from, when that is not {@link ExtensionRecord.path}:
   * the extension's folder inside a verified snapshot of its plugin under
   * `{dorkHome}/extension-snapshots/`, for a project copy that runs by its
   * trusted origin rather than a person's approval of this folder. Compiling,
   * the server half and `ctx.extensionDir` all use it.
   */
  runPath?: string;
  /**
   * The plugin folder digest this copy was judged against. Every compile
   * checks the folder still has it, before and after bundling, so files
   * swapped after the scan never run (`extension-compiler.ts`).
   */
  pinnedDigest?: string;
  /**
   * The path of the copy that runs instead of this one, when both came from
   * the same trusted origin and that copy is newer (spec `flow-multiproject`
   * §9.2). Only a shadowed copy carries it; the copy that runs never does.
   */
  shadowedBy?: string;
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
  /** Content hash of the compiled client bundle; changes whenever the served code does. */
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
  /** The installed marketplace plugin this extension came inside, if any. */
  sourcePlugin?: string;
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
  /**
   * The path of the newer copy that runs instead of this one, or `null` when
   * this is the copy that runs (spec `flow-multiproject` §9.2). Informational:
   * when the same extension is installed in several projects from one trusted
   * source, `GET /api/extensions` also lists each older copy with this set, so
   * an extension can say "this project has an older copy, update it". Every
   * other list (the loader, Settings, the tools) holds only the copies that run.
   */
  shadowedBy: string | null;
  /**
   * Why DorkOS can't vouch for where this copy came from, although its
   * installer recorded it: `changed` (its plugin's files changed after DorkOS
   * installed it) or `linked` (its plugin holds a shortcut to files
   * elsewhere). Settings says so on its card. Absent otherwise. A changed
   * copy of an id a person approved for another copy is not listed at all.
   */
  originProblem?: 'changed' | 'linked';
}

/** The interface an extension module must export. */
export interface ExtensionModule {
  activate(api: import('./extension-api.js').ExtensionAPI): void | (() => void);
}
