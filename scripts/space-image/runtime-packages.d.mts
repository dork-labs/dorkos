/**
 * Types for `runtime-packages.mjs`: what the space image installs. See that file.
 *
 * @module scripts/space-image/runtime-packages
 */

/** Packages the space image must never install, with why. */
export declare const FORBIDDEN_PACKAGES: Readonly<Record<string, string>>;

/** Installed only as unused optional peers; removed from the image before the check. */
export declare const PRUNED: readonly string[];

/**
 * Every package name installed under `<dir>/node_modules`.
 *
 * @param dir - A deployed package folder.
 */
export declare function installedPackages(dir: string): Set<string>;

/**
 * Remove the pruned packages from `<dir>/node_modules`, and every link left pointing at nothing.
 *
 * @param dir - A deployed package folder.
 */
export declare function prune(dir: string): void;

/**
 * The forbidden packages installed under `dir`, each as "<name> (<why>)".
 *
 * @param dir - A deployed package folder.
 */
export declare function forbiddenInstalled(dir: string): string[];
