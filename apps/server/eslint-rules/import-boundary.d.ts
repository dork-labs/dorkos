/**
 * Types for the services import boundary (`import-boundary.js`), for the script that measures
 * what it counts (`scripts/import-boundary/check-import-boundary.ts`).
 */
import type { ESLint } from 'eslint';

/** The baseline file, relative to the server package. */
export declare const BASELINE_FILE: string;
/** The domain a path under `services/` is in; `null` outside it. */
export declare function domainOf(path: string): string | null;
/** The pair (`from -> to`) one import makes, or `null` when it is no edge. */
export declare function edgeOf(file: string, specifier: string): string | null;
/** One named exception: a file under `services/` (no extension), why, and the record behind it. */
export interface BoundaryException {
  path: string;
  reason: string;
  record: string;
}
/** Files every domain may import without making an edge; each imports no domain. */
export declare const PORTS: readonly BoundaryException[];
/** Files whose own imports make no edge, because they import every domain. */
export declare const COMPOSITION_ROOTS: readonly BoundaryException[];
/** The pair an import from a port makes into another domain, or `null`. */
export declare function portLeak(file: string, specifier: string): string | null;
/** The baseline's pairs, each to its number of statements. */
export declare function readBaseline(): Record<string, number>;
declare const plugin: ESLint.Plugin;
export default plugin;
