/**
 * Types for the computer wall (`computer-wall.js`), for the script that measures what it counts
 * (`scripts/computer-wall/check-computer-wall.ts`) and the tests that hold the side map.
 */
import type { ESLint } from 'eslint';

/** A side a path under `services/` can be on. */
export type Side = 'computer' | 'space' | 'kernel' | 'frontDoor';
/** A column of the wall's baseline. */
export type Column = 'space' | 'frontDoor' | 'tables';

/** The baseline file, relative to the server package. */
export declare const BASELINE_FILE: string;
/** The side map, relative to the server package. */
export declare const SIDES_FILE: string;
/** The baseline's columns. */
export declare const COLUMNS: readonly Column[];
/** The four sides. */
export declare const SIDES: readonly Side[];
/** The package whose table names the `tables` column reads. */
export declare const DB_PACKAGE: string;
/** The space-side folders the permission gate note's ratchet counts. */
export declare const GATE_NOTE_FOLDERS: readonly string[];
/** A path under `services/`, relative to it, without extension or trailing `/index`. */
export declare function inServices(path: string): string | null;
/** The side map as written. */
export declare function readSides(): {
  sides: Record<Side, string[]>;
  tables: { computer: string[]; space: string[] };
};
/** Which side a file is on. */
export declare function sideOf(file: string): Side | 'unplaced' | 'outside';
/** Whether a file is a test or a fixture. */
export declare function isTestPath(file: string): boolean;
/** Which column one import from a computer-side file counts in. */
export declare function crossing(file: string, specifier: string): 'space' | 'frontDoor' | null;
/** Whether a name `@dorkos/db` exports is on the space table list. */
export declare function isSpaceTable(name: string): boolean;
/** The baseline's entries. */
export declare function readBaseline(): Record<string, Record<Column, number>>;
declare const plugin: ESLint.Plugin;
export default plugin;
