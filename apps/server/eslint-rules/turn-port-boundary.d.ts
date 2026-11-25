/**
 * Types for the turn port's ratchet (`turn-port-boundary.js`), for the script
 * that measures what it counts (`scripts/turn-port/check-turn-port-boundary.ts`).
 */
import type { ESLint } from 'eslint';

/** The baseline file, relative to the server package. */
export declare const BASELINE_FILE: string;
/** The fourteen space-side domains the rule holds. */
export declare const SPACE_DOMAINS: readonly string[];
/** Which side of the port a file is on. */
export declare function sideOf(file: string): 'space' | 'runs' | 'turn' | 'other';
/** Whether one import crosses the port the wrong way, and which rule it breaks. */
export declare function crossing(file: string, specifier: string): 'space' | 'runs' | 'turn' | null;
/** The baseline's entries. */
export declare function readBaseline(): Record<string, number>;
declare const plugin: ESLint.Plugin;
export default plugin;
