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

/**
 * What DorkOS decided about one tool an extension declares, read from its
 * `extension.json` before any of its code runs (DOR-2685).
 */
export interface ExtensionToolCheckSummary {
  /** The tool's name inside the extension. */
  name: string;
  /** The title a person reads. */
  title: string;
  /** Its permission tier. */
  tier: 'observe' | 'act' | 'destructive';
  /** Whether DorkOS accepted the declaration. */
  ok: boolean;
  /** Why it was refused, when it was. */
  reason?: string;
}

/**
 * Where one declared tool stands right now, as `GET /api/extensions` reports it:
 *
 * - `active`: agents can use it.
 * - `inactive`: accepted, but the extension is not running (off, waiting for
 *   approval, or not started), so agents cannot use it yet.
 * - `refused`: DorkOS will not offer it; `reason` says why.
 */
export interface ExtensionToolStatus {
  /** The tool's name inside the extension. */
  name: string;
  /** The title a person reads. */
  title: string;
  /** Its permission tier. */
  tier: 'observe' | 'act' | 'destructive';
  /** Where it stands. */
  status: 'active' | 'inactive' | 'refused';
  /** Why it was refused, when it was. */
  reason?: string;
}

/** One `allow.run` entry and the program it names on this computer. */
export interface ExtensionResolvedProgram {
  /** The entry as the manifest wrote it: a bare name (`git`) or an absolute path. */
  name: string;
  /**
   * The absolute path of the program DorkOS found for it when it discovered
   * the extension: a bare name looked up on the server's `PATH` (absolute
   * `PATH` folders only, and `PATHEXT` on Windows), an absolute path kept as
   * written. `null` when no runnable file was found on this computer, or when
   * the file sits in extension files (its own folder, package, run folder,
   * dev link, or any extension data folder), which the approval card shows
   * and the program broker refuses. Found by looking
   * at the disk only: nothing is run.
   */
  path: string | null;
  /**
   * Why `path` is `null`, in a plain sentence: not found here, a Windows
   * script that needs a shell, or a file inside extension files (which an
   * update could change without asking). Absent when a program was found.
   */
  reason?: string;
}

/**
 * How an extension that runs separately (`serverCapabilities.runtime:
 * "subprocess"`, DOR-2686) is limited, normalized from its manifest so every
 * consumer — the lifecycle, the approval queue, the app — reads one view.
 */
export interface ExtensionIsolation {
  /** Always `subprocess`: an in-process extension has no isolation view. */
  runtime: 'subprocess';
  /** The `allow.net` entries, as written. */
  net: string[];
  /** The `allow.run` entries, as written. */
  run: string[];
  /** Each `allow.run` entry with the program it names here. */
  resolvedRun: ExtensionResolvedProgram[];
  /** Whether it may message agents and start agent sessions (`allow.agents`). */
  agents: boolean;
  /** Its heap limit in MB (`limits.memoryMb`, default 256). */
  memoryMb: number;
}

/**
 * Whether one skill an extension declares can reach agents, checked against
 * its `skills/` folder when the extension is found (DOR-2685). `reason` is a
 * short sentence for a person, with no paths in it.
 */
export interface ExtensionSkillStatus {
  /** The skill's folder name under `skills/`. */
  name: string;
  /** Whether it is shipped (`ok`) or left out (`dropped`). */
  status: 'ok' | 'dropped';
  /** Why it was left out, when it was. */
  reason?: string;
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
   * symbolic link) or `dev-link` (its plugin runs from a folder a person
   * linked, DOR-2696). A `changed` copy runs only while a person's yes names
   * its files exactly as they are now; a `dev-link` copy only while a yes
   * given to that dev link names it.
   */
  originProblem?: 'changed' | 'linked' | 'dev-link';
  /**
   * Set when the plugin carrying this copy is a dev link (DOR-2696): the real
   * path of the folder it runs from. Such a copy never has a trusted origin,
   * and only an approval given to this dev link covers it.
   */
  devLink?: { path: string };
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
  /**
   * When a restart of an extension that runs separately is pending after it
   * stopped (DOR-2686), as ISO 8601; `null` or absent otherwise. The card says
   * "Restarting <Name>…" while it is set.
   */
  restartingAt?: string | null;
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
  /**
   * What discovery decided about each tool the manifest declares, before any
   * code ran (DOR-2685). Absent when the manifest declares none.
   */
  toolChecks?: ExtensionToolCheckSummary[];
  /**
   * How it is limited when it runs separately (DOR-2686). `null` (or absent,
   * for a record built before discovery filled it) means it runs inside
   * DorkOS with full access.
   */
  isolation?: ExtensionIsolation | null;
  /**
   * What discovery found for each skill the manifest declares (DOR-2685).
   * Absent when the manifest declares none.
   */
  skillChecks?: ExtensionSkillStatus[];
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
  /**
   * When a restart is pending after it stopped (DOR-2686), as ISO 8601, or
   * `null`. See {@link ExtensionRecord.restartingAt}. Absent from an older server.
   */
  restartingAt?: string | null;
  bundleReady: boolean;
  /** Exact advertised bundle/copy correspondence; never a load approval. */
  bundleGeneration?: string;
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
   * elsewhere) or `dev-link` (its plugin runs from a folder you linked).
   * Settings says so on its card. Absent otherwise. A changed copy of an id a
   * person approved for another copy is not listed at all.
   */
  originProblem?: 'changed' | 'linked' | 'dev-link';
  /** Set when the copy runs from a dev link: the real path of its folder. */
  devLink?: { path: string };
  /**
   * The tools this extension gives agents and where each stands (DOR-2685).
   * Absent when its manifest declares none.
   */
  tools?: ExtensionToolStatus[];
  /**
   * How it is limited when it runs separately (DOR-2686); `null` means it
   * runs inside DorkOS with full access. See {@link ExtensionRecord.isolation}.
   */
  isolation?: ExtensionIsolation | null;
  /**
   * The skills this extension ships to agents and whether each made it
   * (DOR-2685). Absent when its manifest declares none.
   */
  skills?: ExtensionSkillStatus[];
}

/** The interface an extension module must export. */
export interface ExtensionModule {
  activate(api: import('./extension-api.js').ExtensionAPI): void | (() => void);
}
