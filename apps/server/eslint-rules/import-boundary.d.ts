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
/** The baseline's pairs, each to its number of statements. */
export declare function readBaseline(): Record<string, number>;
declare const plugin: ESLint.Plugin;
export default plugin;
