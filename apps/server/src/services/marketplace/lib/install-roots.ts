/**
 * Single source of truth for where each marketplace package type installs on
 * disk under `dorkHome`.
 *
 * Every install flow lands a package in a `dorkHome` subdirectory keyed by its
 * type, and every consumer that later enumerates installs — the installed
 * scanner (`GET /api/marketplace/installed`), the update flow, the uninstall
 * flow, and the conflict detector — has to walk that same set of roots. When
 * those two sides drift, a package type installs somewhere no scan looks and
 * becomes invisible: exactly the bug that hid installed Shapes from the
 * `/marketplace?view=installed` view (they land in `shapes/`, but the scanner
 * only walked `plugins/` and `agents/`).
 *
 * This module makes that drift impossible. {@link INSTALL_ROOT_DIR_BY_TYPE} is
 * a total `Record<PackageType, …>`, so adding a package type is a compile error
 * until its install root is declared here; every derived constant below flows
 * from that one map.
 *
 * @module services/marketplace/lib/install-roots
 */
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
 * Resolve the `dorkHome` install subdirectory for a package type.
 *
 * @param type - The marketplace package type.
 * @returns The subdirectory name the type installs into (`plugins`, `agents`,
 *   or `shapes`).
 */
export function installRootDirForType(type: PackageType): InstallRootDir {
  return INSTALL_ROOT_DIR_BY_TYPE[type];
}
