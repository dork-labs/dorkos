/**
 * Single source of truth for where each marketplace package type installs on
 * disk — both under the global `dorkHome` and under a project's own `.dork/`.
 *
 * Every install flow lands a package in a subdirectory keyed by its type, and
 * every consumer that later enumerates installs — the installed scanner
 * (`GET /api/marketplace/installed`), the update flow, the uninstall flow, and
 * the conflict detector — has to walk that same set of roots. When those two
 * sides drift, a package type installs somewhere no scan looks and becomes
 * invisible: exactly the bug that hid installed Shapes from the
 * `/marketplace?view=installed` view (they land in `shapes/`, but the scanner
 * only walked `plugins/` and `agents/`), and again the bug that hid every
 * project-scoped agent (they land in `<projectPath>/.dork/agents/`, but the
 * scanner and the uninstall probe walked only `<projectPath>/.dork/plugins/` —
 * DOR-994).
 *
 * This module makes both drifts impossible. {@link INSTALL_ROOT_DIR_BY_TYPE} is
 * a total `Record<PackageType, …>`, so adding a package type is a compile error
 * until its install root is declared here; every derived constant below flows
 * from that one map. {@link installRootsUnder} then resolves that same set
 * against any scope root, so no caller re-derives which subdirectory a scope
 * holds — the mistake all three blind spots were made of.
 *
 * @module services/marketplace/lib/install-roots
 */
import path from 'node:path';
import type { PackageType } from '@dorkos/marketplace';

/**
 * The `dorkHome` subdirectories that hold installed marketplace packages.
 * Plugins, skill-packs, and adapters share `plugins/`; agents live under
 * `agents/`; Shapes under `shapes/`.
 */
export type InstallRootDir = 'plugins' | 'agents' | 'shapes';

/**
 * The `dorkHome` subdirectory each package type installs into. This is the
 * canonical mapping every other constant in this module derives from; declaring
 * it as a total `Record<PackageType, InstallRootDir>` means a newly added
 * package type will not typecheck until its install root is chosen here.
 */
export const INSTALL_ROOT_DIR_BY_TYPE: Record<PackageType, InstallRootDir> = {
  plugin: 'plugins',
  'skill-pack': 'plugins',
  adapter: 'plugins',
  agent: 'agents',
  shape: 'shapes',
};

/**
 * The distinct set of `dorkHome` subdirectories that hold installed packages,
 * derived from {@link INSTALL_ROOT_DIR_BY_TYPE} so it can never omit a root a
 * package type installs into. Order follows first appearance in the mapping
 * (`plugins`, `agents`, `shapes`).
 */
export const INSTALL_ROOT_DIRS: readonly InstallRootDir[] = [
  ...new Set(Object.values(INSTALL_ROOT_DIR_BY_TYPE)),
];

/**
 * Each distinct install-root subdirectory paired with a representative package
 * type — the first type in {@link INSTALL_ROOT_DIR_BY_TYPE} that maps to it
 * (`plugins`→`plugin`, `agents`→`agent`, `shapes`→`shape`). Used as the type
 * fallback by scanners that infer a package's type only when its manifest is
 * missing or unreadable; the manifest's own `type` field always wins when
 * present. Derived from the mapping so it stays in lockstep with the roots.
 */
export const INSTALL_ROOTS_WITH_TYPE: readonly {
  dir: InstallRootDir;
  representativeType: PackageType;
}[] = (() => {
  const seen = new Map<InstallRootDir, PackageType>();
  for (const [type, dir] of Object.entries(INSTALL_ROOT_DIR_BY_TYPE) as [
    PackageType,
    InstallRootDir,
  ][]) {
    if (!seen.has(dir)) seen.set(dir, type);
  }
  return [...seen].map(([dir, representativeType]) => ({ dir, representativeType }));
})();

/**
 * Whether a directory in an install root may be treated as a package checkout on
 * the strength of its location alone.
 *
 * True for `plugins/` and `shapes/`: everything there arrived as a package, so
 * nothing more needs asking. `forkShape` is the one exception and does not
 * change the answer — a person's fork lands in `shapes/` as a copy of an
 * installed Shape, manifest and all, so it reads as a package either way, and
 * treating it as one costs nothing today because a Shape's applied schedules are
 * written into a skills root rather than into `shapes/`.
 *
 * False for `agents/`, which is also `lib/agents-home.ts`'s directory: it holds
 * every agent DorkOS creates from the New Agent flow, with installed agent
 * packages living among them. A directory there needs a second question asked of
 * it before anyone may call it a package checkout.
 *
 * That distinction is only ever load-bearing where the answer decides whether
 * DorkOS may WRITE — `services/tasks/task-file-update.ts`, which refuses to edit
 * a schedule an installed package owns. Reading a root the person also fills is
 * harmless (the conflict detector deliberately wants a hand-made agent's skills
 * in its collision set); writing into it is not, and refusing every edit to
 * every agent a person made would be the same bug pointed the other way. That
 * consumer does not search `agents/` at all — it asks the owning agent's own
 * directory directly — so this flag is what tells it which roots to leave out.
 *
 * Declared as a total `Record<InstallRootDir, boolean>` for the same reason
 * {@link INSTALL_ROOT_DIR_BY_TYPE} is: a newly added root will not typecheck
 * until someone decides which kind it is.
 */
export const INSTALL_ROOT_HOLDS_PACKAGES_ONLY: Record<InstallRootDir, boolean> = {
  plugins: true,
  agents: false,
  shapes: true,
};

/**
 * Resolve the `dorkHome` install subdirectory for a package type.
 *
 * @param type - The marketplace package type.
 * @returns The subdirectory name the type installs into (`plugins`, `agents`,
 *   or `shapes`).
 */
export function installRootDirForType(type: PackageType): InstallRootDir {
  return INSTALL_ROOT_DIR_BY_TYPE[type];
}

/**
 * One install root resolved against a scope root — the absolute directory to
 * walk, plus the two labels every caller needs about it.
 */
export interface ScopedInstallRoot {
  /**
   * The root's scope-relative name (`plugins`/`agents`/`shapes`). This, never
   * the absolute {@link ScopedInstallRoot.dir}, is what identifies "the same
   * root" across scopes — see {@link installKey}.
   */
  kind: InstallRootDir;
  /** Absolute directory holding one subdirectory per installed package. */
  dir: string;
  /**
   * Fallback package type for an install in this root whose manifest is
   * missing or does not name one. A present manifest `type` always wins.
   */
  representativeType: PackageType;
  /**
   * Whether a directory here is an installed package by its location alone —
   * {@link INSTALL_ROOT_HOLDS_PACKAGES_ONLY} for this root's kind. False for
   * `agents/`, which DorkOS also fills with the agents a person makes.
   */
  packagesOnly: boolean;
}

/**
 * The directory a project's install roots hang off.
 *
 * A project-scoped install lands under `<projectPath>/.dork/<root>/<name>`, so
 * the scope root carries the `.dork` suffix. `dorkHome` needs no counterpart
 * helper: it already IS the global `.dork` directory.
 *
 * @param projectPath - The project (or agent) directory.
 * @returns The project's `.dork` scope root.
 */
export function projectScopeRoot(projectPath: string): string {
  return path.join(projectPath, '.dork');
}

/**
 * Resolve every install root under one scope root, in
 * {@link INSTALL_ROOTS_WITH_TYPE} order (`plugins`, `agents`, `shapes`).
 *
 * Callers pass either `dorkHome` (the global scope) or a
 * {@link projectScopeRoot}; the set of roots is identical either way, which is
 * the point — a scope that happens to hold no Shapes simply yields an
 * unreadable `shapes/` that every walker already skips, and a scope that grows
 * a new root gains it everywhere at once.
 *
 * @param scopeRoot - `dorkHome`, or a project's `.dork` directory.
 * @returns Each install root resolved under `scopeRoot`.
 */
export function installRootsUnder(scopeRoot: string): ScopedInstallRoot[] {
  return INSTALL_ROOTS_WITH_TYPE.map(({ dir, representativeType }) => ({
    kind: dir,
    dir: path.join(scopeRoot, dir),
    representativeType,
    packagesOnly: INSTALL_ROOT_HOLDS_PACKAGES_ONLY[dir],
  }));
}

/**
 * The identity of an installation for the purpose of deduplicating or shadowing
 * across scopes: its install-root kind plus its package name.
 *
 * Keying on the name alone is wrong, and was the shape of the DOR-994 bug's
 * near miss: two same-name packages in different roots (a `plugins/flow` and an
 * `agents/flow`) are genuinely different packages the {@link ConflictDetector}
 * allows to coexist, so a project's `agents/flow` must not shadow or delete the
 * global `plugins/flow`. Keying on the absolute directory is wrong the other
 * way: project and global paths always differ, so nothing would ever match.
 *
 * @param kind - The scope-relative install root the package was found in.
 * @param name - The package name.
 * @returns The cross-scope identity key.
 */
export function installKey(kind: InstallRootDir, name: string): string {
  return `${kind}:${name}`;
}
